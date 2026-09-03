import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    areSamePaths,
    DEFAULT_REVIEW_WORKTREE_PATH,
    DirtyReviewWorktreeError,
    fetchPullRequestCommit,
    fetchPullRequestSnapshot,
    getPrimaryWorktreeRoot,
    parseWorktreePaths,
    prepareReviewWorktree,
    resolveReviewWorktreePath,
} from '../../git/reviewWorktree';

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function createRepository(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'azdo-review-worktree-'));
    git(root, 'init');
    fs.writeFileSync(path.join(root, 'file.txt'), 'first');
    git(root, 'add', 'file.txt');
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'first');
    return root;
}

suite('reviewWorktree', () => {
    const cleanup: string[] = [];
    const worktrees: { root: string; path: string }[] = [];

    teardown(() => {
        for (const worktree of worktrees.splice(0)) {
            try { git(worktree.root, 'worktree', 'remove', '--force', worktree.path); } catch { /* best-effort cleanup */ }
        }
        for (const root of cleanup.splice(0).reverse()) {
            try {
                fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            } catch { /* best-effort cleanup on Windows */ }
        }
    });

    test('resolves the default sibling review path', () => {
        const root = path.join('C:', 'src', 'sample');
        assert.strictEqual(
            resolveReviewWorktreePath(root, DEFAULT_REVIEW_WORKTREE_PATH),
            path.resolve(root, '..', 'sample.worktrees', 'review'),
        );
    });

    test('resolves absolute configured paths unchanged', () => {
        const configured = path.resolve('custom', 'review');
        assert.strictEqual(resolveReviewWorktreePath(path.resolve('repo'), configured), configured);
    });

    test('compares normalized paths', () => {
        assert.strictEqual(areSamePaths(path.join('repo', 'review'), path.join('repo', '.', 'review')), true);
    });

    test('parses worktree porcelain paths', () => {
        assert.deepStrictEqual(parseWorktreePaths('worktree C:/repo\nHEAD abc\n\nworktree C:/repo.worktrees/review\nHEAD def\n'), [
            'C:/repo',
            'C:/repo.worktrees/review',
        ]);
    });

    test('creates and reuses one detached worktree', async () => {
        const root = createRepository();
        cleanup.push(root);
        const reviewPath = path.join(path.dirname(root), `${path.basename(root)}.worktrees`, 'review worktree');
        cleanup.push(path.dirname(reviewPath));
        const firstCommit = git(root, 'rev-parse', 'HEAD');

        const created = await prepareReviewWorktree(root, reviewPath, firstCommit);
        worktrees.push({ root, path: reviewPath });
        assert.strictEqual(created.reused, false);
        assert.strictEqual(git(reviewPath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');

        fs.writeFileSync(path.join(root, 'file.txt'), 'second');
        git(root, 'add', 'file.txt');
        git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'second');
        const secondCommit = git(root, 'rev-parse', 'HEAD');
        const reused = await prepareReviewWorktree(root, reviewPath, secondCommit);

        assert.strictEqual(reused.reused, true);
        assert.strictEqual(git(reviewPath, 'rev-parse', 'HEAD'), secondCommit);
        assert.strictEqual(await getPrimaryWorktreeRoot(reviewPath), root);
    });

    test('refuses to replace a dirty review worktree', async () => {
        const root = createRepository();
        cleanup.push(root);
        const reviewPath = path.join(path.dirname(root), `${path.basename(root)}.worktrees`, 'review');
        cleanup.push(path.dirname(reviewPath));
        const commit = git(root, 'rev-parse', 'HEAD');
        await prepareReviewWorktree(root, reviewPath, commit);
        worktrees.push({ root, path: reviewPath });
        fs.writeFileSync(path.join(reviewPath, 'untracked.txt'), 'keep me');

        await assert.rejects(
            prepareReviewWorktree(root, reviewPath, commit),
            err => err instanceof DirtyReviewWorktreeError,
        );
        assert.strictEqual(fs.readFileSync(path.join(reviewPath, 'untracked.txt'), 'utf-8'), 'keep me');
    });

    test('refuses to replace a worktree with an in-progress Git operation', async () => {
        const root = createRepository();
        cleanup.push(root);
        const reviewPath = path.join(path.dirname(root), `${path.basename(root)}.worktrees`, 'review');
        cleanup.push(path.dirname(reviewPath));
        const commit = git(root, 'rev-parse', 'HEAD');
        await prepareReviewWorktree(root, reviewPath, commit);
        worktrees.push({ root, path: reviewPath });
        const mergeHead = git(reviewPath, 'rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD');
        fs.writeFileSync(mergeHead, commit);

        await assert.rejects(
            prepareReviewWorktree(root, reviewPath, commit),
            err => err instanceof DirtyReviewWorktreeError,
        );
    });

    test('refuses the primary repository as the review path', async () => {
        const root = createRepository();
        cleanup.push(root);
        const commit = git(root, 'rev-parse', 'HEAD');

        await assert.rejects(prepareReviewWorktree(root, root, commit), /primary repository root/);
    });

    test('refuses a non-empty unregistered worktree path', async () => {
        const root = createRepository();
        cleanup.push(root);
        const reviewPath = fs.mkdtempSync(path.join(os.tmpdir(), 'azdo-review-existing-'));
        cleanup.push(reviewPath);
        fs.writeFileSync(path.join(reviewPath, 'keep.txt'), 'keep me');
        const commit = git(root, 'rev-parse', 'HEAD');

        await assert.rejects(prepareReviewWorktree(root, reviewPath, commit), /exists and is not empty/);
        assert.strictEqual(fs.readFileSync(path.join(reviewPath, 'keep.txt'), 'utf-8'), 'keep me');
    });

    test('fetches a source ref and returns its commit without creating a branch', async () => {
        const remote = createRepository();
        cleanup.push(remote);
        git(remote, 'branch', '-M', 'feature/test');
        const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'azdo-review-clone-'));
        cleanup.push(clone);
        git(clone, 'init');
        git(clone, 'remote', 'add', 'origin', remote);

        const commit = await fetchPullRequestCommit(clone, 'origin', 'refs/heads/feature/test');

        assert.strictEqual(commit, git(remote, 'rev-parse', 'HEAD'));
        assert.strictEqual(git(clone, 'branch', '--list', 'feature/test'), '');
    });

    test('reports the source ref when it cannot be fetched', async () => {
        const remote = createRepository();
        cleanup.push(remote);
        const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'azdo-review-clone-'));
        cleanup.push(clone);
        git(clone, 'init');
        git(clone, 'remote', 'add', 'origin', remote);

        await assert.rejects(
            fetchPullRequestCommit(clone, 'origin', 'refs/heads/missing'),
            /Unable to fetch PR source ref refs\/heads\/missing from origin/,
        );
    });

    test('fetches a PR snapshot without changing the checkout', async () => {
        const remote = createRepository();
        cleanup.push(remote);
        git(remote, 'branch', '-M', 'main');
        git(remote, 'checkout', '-b', 'feature/test');
        fs.writeFileSync(path.join(remote, 'file.txt'), 'feature');
        git(remote, 'add', 'file.txt');
        git(remote, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'feature');

        const clone = createRepository();
        cleanup.push(clone);
        git(clone, 'remote', 'add', 'origin', remote);
        fs.writeFileSync(path.join(clone, 'file.txt'), 'dirty working copy');
        const headBefore = git(clone, 'rev-parse', 'HEAD');
        const branchBefore = git(clone, 'branch', '--show-current');

        const snapshot = await fetchPullRequestSnapshot(
            clone, 'origin', 42, 'refs/heads/feature/test', 'refs/heads/main',
        );

        assert.strictEqual(snapshot.sourceCommit, git(remote, 'rev-parse', 'feature/test'));
        assert.strictEqual(snapshot.targetCommit, git(remote, 'rev-parse', 'main'));
        assert.strictEqual(git(clone, 'rev-parse', 'HEAD'), headBefore);
        assert.strictEqual(git(clone, 'branch', '--show-current'), branchBefore);
        assert.strictEqual(fs.readFileSync(path.join(clone, 'file.txt'), 'utf-8'), 'dirty working copy');
        assert.strictEqual(git(clone, 'branch', '--list', 'feature/test'), '');
    });

    test('fetches a PR snapshot directly from a repository path', async () => {
        const remote = createRepository();
        cleanup.push(remote);
        git(remote, 'branch', '-M', 'main');
        git(remote, 'checkout', '-b', 'feature/direct');
        const clone = createRepository();
        cleanup.push(clone);

        const snapshot = await fetchPullRequestSnapshot(
            clone, remote, 43, 'refs/heads/feature/direct', 'refs/heads/main',
        );

        assert.strictEqual(snapshot.sourceCommit, git(remote, 'rev-parse', 'feature/direct'));
        assert.strictEqual(snapshot.targetCommit, git(remote, 'rev-parse', 'main'));
    });
});