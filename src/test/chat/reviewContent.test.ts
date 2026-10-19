import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { VersionControlChangeType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { ReviewContent, gitText, reviewPath, type ReviewTarget } from '../../chat/reviewContent';
import { fileContentKey } from '../../azdo/prService';
import type { ReviewMode } from '../../git/gitStateDetector';
import { CopilotReviewService } from '../../chat/copilotReview';
import { getBuiltInReviewLens } from '../../chat/reviewLenses';
import { PrCommentController } from '../../views/prCommentController';

suite('Review content', () => {
    const directories: string[] = [];
    teardown(async () => {
        for (const directory of directories.splice(0)) { await fs.rm(directory, { recursive: true, force: true }); }
    });

    test('rejects absolute, traversing, ambiguous, and control-character paths', () => {
        for (const value of ['', '/root', '..\\secret', 'a/../b', 'a//b', './a', 'C:\\file', 'file\nname']) {
            assert.throws(() => reviewPath(value), /repository-relative/);
        }
        assert.strictEqual(reviewPath('src\\file with spaces.ts'), 'src/file with spaces.ts');
    });

    test('builds exact rename, addition, deletion, and binary comparison content without Git', async () => {
        const target: ReviewTarget = {
            identity: 'snapshot', snapshot: true, checkoutBacked: false, sourceRef: 'source', targetRef: 'base',
            filePaths: ['new name.ts', 'added.ts', 'removed.ts', 'binary.bin'],
            originalPaths: new Map([['new name.ts', 'old name.ts']]),
            changeTypes: new Map([
                ['new name.ts', VersionControlChangeType.Rename | VersionControlChangeType.Edit],
                ['added.ts', VersionControlChangeType.Add],
                ['removed.ts', VersionControlChangeType.Delete],
                ['binary.bin', VersionControlChangeType.Edit],
            ]),
            contents: new Map([
                [fileContentKey('base', 'old name.ts'), 'old\n'],
                [fileContentKey('source', 'new name.ts'), 'new\n'],
                [fileContentKey('source', 'added.ts'), 'added\n'],
                [fileContentKey('base', 'removed.ts'), 'removed\n'],
                [fileContentKey('base', 'binary.bin'), '\0old'],
                [fileContentKey('source', 'binary.bin'), '\0new'],
            ]),
        };
        const content = new ReviewContent(target, 'vs-target');
        await content.load();
        assert.strictEqual(await content.read('new name.ts', 'base'), 'old\n');
        assert.ok(content.files[0].diff.includes('a/old name.ts'));
        assert.ok(content.files[0].diff.includes('b/new name.ts'));
        assert.ok(content.files[1].diff.includes('/dev/null'));
        assert.strictEqual(content.files[2].sourceExists, false);
        assert.strictEqual(content.files[3].diff, 'Binary file changed: binary.bin');
        await assert.rejects(content.read('removed.ts'), /does not exist/);
        await assert.rejects(content.read('added.ts', 'base'), /does not exist/);
    });

    test('computes every local scope from the actual index, worktree, and commits without remote writes', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'azdo-review-content-'));
        directories.push(root);
        await gitText(root, ['init', '--initial-branch=feature']);
        const file = path.join(root, 'file with spaces.ts');
        await fs.writeFile(file, 'base\n');
        await gitText(root, ['add', '.']);
        await gitText(root, ['-c', 'user.name=Review Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base']);
        const base = (await gitText(root, ['rev-parse', 'HEAD'])).trim();
        await gitText(root, ['update-ref', 'refs/remotes/origin/main', base]);
        await gitText(root, ['update-ref', 'refs/remotes/origin/feature', base]);
        await fs.writeFile(file, 'committed\n');
        await gitText(root, ['add', '.']);
        await gitText(root, ['-c', 'user.name=Review Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'source']);
        await fs.writeFile(file, 'staged\n');
        await gitText(root, ['add', '.']);
        await fs.writeFile(file, 'working\n');
        const target: ReviewTarget = {
            identity: root, repositoryRoot: vscode.Uri.file(root),
            snapshot: false, checkoutBacked: true, targetRef: 'origin/main',
            currentBranch: 'feature', filePaths: [], changeTypes: new Map(),
        };
        const expectations: [ReviewMode, string, string][] = [
            ['staged', 'committed\n', 'staged\n'],
            ['unstaged', 'staged\n', 'working\n'],
            ['all-uncommitted', 'committed\n', 'working\n'],
            ['unpushed-commits', 'base\n', 'committed\n'],
            ['vs-target', 'base\n', 'working\n'],
        ];
        for (const [mode, expectedBase, source] of expectations) {
            const content = new ReviewContent(target, mode);
            await content.load();
            assert.strictEqual(content.files.length, 1, mode);
            assert.strictEqual(content.files[0].path, 'file with spaces.ts');
            assert.strictEqual(content.files[0].base, expectedBase, mode);
            assert.strictEqual(content.files[0].source, source, mode);
            await content.assertUnchanged(['file with spaces.ts']);
        }
        const log: vscode.OutputChannel = {
            name: 'local review test', append: () => { }, appendLine: () => { }, replace: () => { },
            clear: () => { }, show: () => { }, hide: () => { }, dispose: () => { },
        };
        const comments = new PrCommentController(log);
        comments.setPrContext(undefined, 42, ['file with spaces.ts'], undefined, undefined, 'server-base', 'server-source');
        comments.setReviewMode(true);
        const localTarget = { ...target, pr: { pullRequestId: 42 } };
        const service = new CopilotReviewService({
            prepareTarget: async () => localTarget, currentTarget: () => localTarget,
            comments, lenses: { resolveLens: async () => getBuiltInReviewLens('general') }, log,
        });
        try {
            const run = await service.start({ mode: 'staged' });
            await service.createDrafts(run, [{ path: 'file with spaces.ts', line: 1, body: 'Review staged code.' }], new vscode.CancellationTokenSource().token);
            const saved = comments.serializeDrafts();
            assert.strictEqual(saved.aiDrafts[0].documentContent, 'staged\n');
            assert.strictEqual(saved.aiDrafts[0].localOnly, true);
            assert.ok(saved.aiDrafts[0].documentUri?.startsWith('azdo-pr-ai-review:'));
            const uri = comments.getDraftSummaries()[0].uri!;
            assert.strictEqual(service.provideTextDocumentContent(uri), 'staged\n');
            service.discard(run);
            comments.restoreDrafts(saved);
            assert.strictEqual(service.provideTextDocumentContent(uri), 'staged\n', 'persisted drafts must retain captured code independently of run lifetime');
        } finally {
            service.dispose();
            comments.dispose();
        }
        const captured = new ReviewContent(target, 'all-uncommitted');
        await captured.load();
        await fs.writeFile(file, 'modified after review\n');
        await assert.rejects(captured.assertUnchanged(['file with spaces.ts']), /changed after this review/);
        assert.strictEqual((await gitText(root, ['rev-parse', 'refs/remotes/origin/main'])).trim(), base);
    });
});
