/**
 * Integration tests: real git repositories on disk.
 *
 * Creates temporary git repos (simple clone, worktree) with actual files,
 * then verifies that the RepositoryDetector → PrCommentController chain
 * produces file URIs that point to real, existing files.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';

import { RepositoryDetector } from '../../azdo/repositoryDetector';
import { PrCommentController } from '../../views/prCommentController';
import { GitRefContentProvider, GIT_CONTENT_SCHEME, buildGitRefUri } from '../../views/gitRefContentProvider';
import type { API, Repository, RepositoryState, Remote } from '../../typings/git';
import { CommentType, CommentThreadStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLog(): vscode.OutputChannel {
    return {
        appendLine: () => { },
        append: () => { },
        clear: () => { },
        show: () => { },
        hide: () => { },
        dispose: () => { },
        replace: () => { },
        name: 'test',
    } as unknown as vscode.OutputChannel;
}

/** Create a mock Repository whose rootUri points at a real directory. */
function repoAt(dirPath: string): Repository {
    const remotes = listGitRemotes(dirPath);
    const stateEmitter = new vscode.EventEmitter<void>();
    return {
        rootUri: vscode.Uri.file(dirPath),
        state: {
            remotes,
            HEAD: undefined,
            refs: [],
            onDidChange: stateEmitter.event,
        } as unknown as RepositoryState,
    } as unknown as Repository;
}

/** Read git remotes from an actual repo on disk for use in mock state. */
function listGitRemotes(repoPath: string): Remote[] {
    try {
        const out = execFileSync('git', ['remote', '-v'], { cwd: repoPath, encoding: 'utf-8' });
        const seen = new Map<string, Remote>();
        for (const line of out.trim().split('\n')) {
            if (!line) { continue; }
            const [name, url, kind] = line.split(/\s+/);
            const existing = seen.get(name);
            if (kind === '(fetch)') {
                seen.set(name, { name, fetchUrl: url, pushUrl: existing?.pushUrl, isReadOnly: false } as Remote);
            } else {
                seen.set(name, { name, fetchUrl: existing?.fetchUrl, pushUrl: url, isReadOnly: false } as Remote);
            }
        }
        return [...seen.values()];
    } catch {
        return [];
    }
}

function makeGitApi(repos: Repository[]): API {
    const openEmitter = new vscode.EventEmitter<Repository>();
    const closeEmitter = new vscode.EventEmitter<Repository>();
    return {
        repositories: repos,
        onDidOpenRepository: openEmitter.event,
        onDidCloseRepository: closeEmitter.event,
    } as unknown as API;
}

function makeAzdoThread(filePath: string, id = 1): GitPullRequestCommentThread {
    return {
        id,
        comments: [{
            content: 'Test comment',
            author: { displayName: 'Alice' },
            commentType: CommentType.Text,
            isDeleted: false,
            publishedDate: new Date('2026-01-01'),
        }],
        threadContext: {
            filePath,
            rightFileStart: { line: 1, offset: 1 },
            rightFileEnd: { line: 1, offset: 1 },
        },
        status: CommentThreadStatus.Active,
        isDeleted: false,
    } as any;
}

/** Run a git command in a directory. */
function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

/** Create a disposable temp directory. */
function makeTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Recursively remove a directory (best-effort). */
function rmdir(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Test: simple clone
// ---------------------------------------------------------------------------

suite('Integration: simple clone — file resolution', () => {
    let tmpDir: string;
    const AZDO_URL = 'https://dev.azure.com/testorg/testproj/_git/testrepo';

    setup(() => {
        tmpDir = makeTempDir('azdo-test-clone-');
        git(tmpDir, 'init');
        git(tmpDir, 'remote', 'add', 'origin', AZDO_URL);
        // Create some files
        fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test');
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {}');
        fs.mkdirSync(path.join(tmpDir, 'src', 'utils'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'src', 'utils', 'helper.ts'), 'export function help() {}');
    });

    teardown(() => { rmdir(tmpDir); });

    test('detector finds AzDo remote from real git repo', () => {
        const repo = repoAt(tmpDir);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.ok(detector.currentRemoteInfo, 'should detect AzDo remote');
        assert.strictEqual(detector.currentRemoteInfo!.organization, 'testorg');
        assert.strictEqual(detector.currentRemoteInfo!.project, 'testproj');
        assert.strictEqual(detector.currentRemoteInfo!.repositoryName, 'testrepo');
        assert.strictEqual(detector.currentRemoteInfo!.apiBaseUrl, 'https://dev.azure.com/testorg');
        assert.strictEqual(detector.currentRemoteInfo!.repository, repo);
        detector.dispose();
    });

    test('draft thread URI points to a real file on disk', () => {
        const repo = repoAt(tmpDir);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);

        const thread = controller.createDraftThread('src/index.ts', 1, 'test');
        assert.ok(thread, 'should create draft thread');
        assert.strictEqual(thread!.uri.scheme, 'file');
        // The URI should point to the real file
        assert.ok(fs.existsSync(thread!.uri.fsPath), `File should exist at: ${thread!.uri.fsPath}`);

        controller.dispose();
        detector.dispose();
    });

    test('draft thread URI for nested file points to real file', () => {
        const repo = repoAt(tmpDir);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);

        const thread = controller.createDraftThread('src/utils/helper.ts', 1, 'helper');
        assert.ok(thread);
        assert.ok(fs.existsSync(thread!.uri.fsPath), `File should exist at: ${thread!.uri.fsPath}`);

        controller.dispose();
        detector.dispose();
    });

    test('draft thread URI for root-level file points to real file', () => {
        const repo = repoAt(tmpDir);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);

        const thread = controller.createDraftThread('README.md', 1, 'readme');
        assert.ok(thread);
        assert.ok(fs.existsSync(thread!.uri.fsPath), `File should exist at: ${thread!.uri.fsPath}`);

        controller.dispose();
        detector.dispose();
    });

    test('updateThreads with AzDO paths resolves without error', async () => {
        const repo = repoAt(tmpDir);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);
        controller.setReviewMode(true);

        // AzDO paths have leading '/'
        await controller.updateThreads([
            makeAzdoThread('/src/index.ts', 1),
            makeAzdoThread('/README.md', 2),
            makeAzdoThread('/src/utils/helper.ts', 3),
        ]);

        controller.dispose();
        detector.dispose();
    });

    test('gitRefContentProvider resolves correct repoRoot for git show', () => {
        const repo = repoAt(tmpDir);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const provider = new GitRefContentProvider(createMockLog(), api, detector);

        // Build a URI for a file at a ref
        const uri = buildGitRefUri('src/index.ts', 'HEAD');
        assert.strictEqual(uri.scheme, GIT_CONTENT_SCHEME);
        assert.ok(uri.path.includes('src/index.ts'));

        // The provider would need a committed file to actually return content,
        // but we can verify the URI construction is correct
        assert.strictEqual(new URLSearchParams(uri.query).get('ref'), 'HEAD');
    });

    test('gitRefContentProvider returns empty for __empty__ path', async () => {
        const repo = repoAt(tmpDir);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const provider = new GitRefContentProvider(createMockLog(), api, detector);

        const uri = buildGitRefUri('__empty__', 'HEAD');
        const content = await provider.provideTextDocumentContent(uri, new vscode.CancellationTokenSource().token);
        assert.strictEqual(content, '');
    });

    test('committed file can be read via gitRefContentProvider', async () => {
        // Commit the files so git show works
        git(tmpDir, 'add', '-A');
        git(tmpDir, '-c', 'user.email=test@test.com', '-c', 'user.name=Test', 'commit', '-m', 'init');

        const repo = repoAt(tmpDir);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const provider = new GitRefContentProvider(createMockLog(), api, detector);

        const uri = buildGitRefUri('src/index.ts', 'HEAD');
        const content = await provider.provideTextDocumentContent(uri, new vscode.CancellationTokenSource().token);
        assert.strictEqual(content, 'export {}');
    });
});

// ---------------------------------------------------------------------------
// Test: worktree
// ---------------------------------------------------------------------------

suite('Integration: worktree — file resolution', () => {
    let mainDir: string;
    let worktreeDir: string;
    const AZDO_URL = 'https://dev.azure.com/myorg/myproject/_git/myrepo';

    setup(() => {
        // Create a main repo with a commit (required for worktrees)
        mainDir = makeTempDir('azdo-test-main-');
        git(mainDir, 'init');
        git(mainDir, 'remote', 'add', 'origin', AZDO_URL);
        fs.writeFileSync(path.join(mainDir, 'README.md'), '# Main');
        fs.mkdirSync(path.join(mainDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(mainDir, 'src', 'index.ts'), 'export const main = true;');
        git(mainDir, 'add', '-A');
        git(mainDir, '-c', 'user.email=test@test.com', '-c', 'user.name=Test', 'commit', '-m', 'init');

        // Create a worktree — git worktree add <path> -b <branch>
        worktreeDir = makeTempDir('azdo-test-wt-');
        // Remove the dir first — git worktree add needs a non-existent path
        rmdir(worktreeDir);
        git(mainDir, 'worktree', 'add', worktreeDir, '-b', 'feature-branch');

        // Add a file unique to the worktree
        fs.mkdirSync(path.join(worktreeDir, 'src', 'feature'), { recursive: true });
        fs.writeFileSync(path.join(worktreeDir, 'src', 'feature', 'new.ts'), 'export const feature = true;');
    });

    teardown(() => {
        // Must remove worktree before main (git locks)
        try { git(mainDir, 'worktree', 'remove', worktreeDir, '--force'); } catch { /* best-effort */ }
        rmdir(worktreeDir);
        rmdir(mainDir);
    });

    test('both main and worktree have the same AzDo remote', () => {
        const mainRepo = repoAt(mainDir);
        const wtRepo = repoAt(worktreeDir);

        // Both should have the origin remote pointing to AzDo
        const mainRemotes = mainRepo.state.remotes;
        const wtRemotes = wtRepo.state.remotes;
        assert.ok(mainRemotes.length > 0, 'main should have remotes');
        assert.ok(wtRemotes.length > 0, 'worktree should have remotes');

        const mainOrigin = mainRemotes.find(r => r.name === 'origin');
        const wtOrigin = wtRemotes.find(r => r.name === 'origin');
        assert.ok(mainOrigin, 'main should have origin remote');
        assert.ok(wtOrigin, 'worktree should have origin remote');
        assert.strictEqual(mainOrigin!.fetchUrl, AZDO_URL);
        assert.strictEqual(wtOrigin!.fetchUrl, AZDO_URL);
    });

    test('detector picks first repo (main) when main is listed first', () => {
        const mainRepo = repoAt(mainDir);
        const wtRepo = repoAt(worktreeDir);
        const api = makeGitApi([mainRepo, wtRepo]);
        const detector = new RepositoryDetector(api, createMockLog());

        assert.ok(detector.currentRemoteInfo);
        assert.strictEqual(detector.currentRemoteInfo!.repository, mainRepo);
        assert.strictEqual(detector.currentRemoteInfo!.organization, 'myorg');

        detector.dispose();
    });

    test('detector picks worktree when worktree is listed first', () => {
        const mainRepo = repoAt(mainDir);
        const wtRepo = repoAt(worktreeDir);
        const api = makeGitApi([wtRepo, mainRepo]);
        const detector = new RepositoryDetector(api, createMockLog());

        assert.ok(detector.currentRemoteInfo);
        assert.strictEqual(detector.currentRemoteInfo!.repository, wtRepo);

        detector.dispose();
    });

    test('draft thread URI uses worktree root when worktree is detected', () => {
        const mainRepo = repoAt(mainDir);
        const wtRepo = repoAt(worktreeDir);
        // Worktree first — simulates the worktree being the active workspace
        const api = makeGitApi([wtRepo, mainRepo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);

        const thread = controller.createDraftThread('src/index.ts', 1, 'test');
        assert.ok(thread);
        // URI should be under the worktree dir, NOT the main repo
        const wtUri = vscode.Uri.file(worktreeDir);
        assert.ok(
            thread!.uri.toString().startsWith(wtUri.toString()),
            `URI should start with worktree root. Got: ${thread!.uri.toString()}, Expected prefix: ${wtUri.toString()}`,
        );
        // And the file should exist (it was committed in main and inherited by worktree)
        assert.ok(fs.existsSync(thread!.uri.fsPath), `File should exist at: ${thread!.uri.fsPath}`);

        controller.dispose();
        detector.dispose();
    });

    test('draft thread URI uses main root when main is detected', () => {
        const mainRepo = repoAt(mainDir);
        const wtRepo = repoAt(worktreeDir);
        // Main first
        const api = makeGitApi([mainRepo, wtRepo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);

        const thread = controller.createDraftThread('src/index.ts', 1, 'test');
        assert.ok(thread);
        const mainUri = vscode.Uri.file(mainDir);
        assert.ok(
            thread!.uri.toString().startsWith(mainUri.toString()),
            `URI should start with main root. Got: ${thread!.uri.toString()}, Expected prefix: ${mainUri.toString()}`,
        );
        assert.ok(fs.existsSync(thread!.uri.fsPath), `File should exist at: ${thread!.uri.fsPath}`);

        controller.dispose();
        detector.dispose();
    });

    test('worktree-only file resolves correctly when worktree is detected', () => {
        const wtRepo = repoAt(worktreeDir);
        const api = makeGitApi([wtRepo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);

        // This file only exists in the worktree
        const thread = controller.createDraftThread('src/feature/new.ts', 1, 'worktree-only');
        assert.ok(thread);
        assert.ok(fs.existsSync(thread!.uri.fsPath), `Worktree-only file should exist at: ${thread!.uri.fsPath}`);

        controller.dispose();
        detector.dispose();
    });

    test('worktree-only file does NOT exist under main repo root', () => {
        const mainRepo = repoAt(mainDir);
        const api = makeGitApi([mainRepo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);

        // This file only exists in the worktree, not in main
        const thread = controller.createDraftThread('src/feature/new.ts', 1, 'should not exist');
        assert.ok(thread);
        assert.ok(!fs.existsSync(thread!.uri.fsPath),
            `File should NOT exist in main repo: ${thread!.uri.fsPath}`);

        controller.dispose();
        detector.dispose();
    });

    test('committed file readable via gitRefContentProvider from worktree', async () => {
        const wtRepo = repoAt(worktreeDir);
        const api = makeGitApi([wtRepo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const provider = new GitRefContentProvider(createMockLog(), api, detector);

        const uri = buildGitRefUri('src/index.ts', 'HEAD');
        const content = await provider.provideTextDocumentContent(uri, new vscode.CancellationTokenSource().token);
        assert.strictEqual(content, 'export const main = true;');
    });

    test('committed file readable via gitRefContentProvider from main', async () => {
        const mainRepo = repoAt(mainDir);
        const api = makeGitApi([mainRepo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const provider = new GitRefContentProvider(createMockLog(), api, detector);

        const uri = buildGitRefUri('src/index.ts', 'HEAD');
        const content = await provider.provideTextDocumentContent(uri, new vscode.CancellationTokenSource().token);
        assert.strictEqual(content, 'export const main = true;');
    });

    test('API metadata is identical regardless of which repo is detected', () => {
        const mainRepo = repoAt(mainDir);
        const wtRepo = repoAt(worktreeDir);

        // Main first
        const api1 = makeGitApi([mainRepo, wtRepo]);
        const det1 = new RepositoryDetector(api1, createMockLog());
        const info1 = det1.currentRemoteInfo!;

        // Worktree first
        const api2 = makeGitApi([wtRepo, mainRepo]);
        const det2 = new RepositoryDetector(api2, createMockLog());
        const info2 = det2.currentRemoteInfo!;

        // API fields should be identical
        assert.strictEqual(info1.organization, info2.organization);
        assert.strictEqual(info1.project, info2.project);
        assert.strictEqual(info1.repositoryName, info2.repositoryName);
        assert.strictEqual(info1.apiBaseUrl, info2.apiBaseUrl);
        assert.strictEqual(info1.remoteName, info2.remoteName);

        // But the repository references should differ
        assert.notStrictEqual(info1.repository, info2.repository);

        det1.dispose();
        det2.dispose();
    });
});

// ---------------------------------------------------------------------------
// Test: multiple remotes on real repo
// ---------------------------------------------------------------------------

suite('Integration: mixed remotes — detection priority', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = makeTempDir('azdo-test-mixed-');
        git(tmpDir, 'init');
        // Add non-AzDo remote first
        git(tmpDir, 'remote', 'add', 'github', 'https://github.com/user/repo.git');
        // Add AzDo remote second
        git(tmpDir, 'remote', 'add', 'azure', 'https://dev.azure.com/myorg/myproj/_git/myrepo');
        fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'test');
    });

    teardown(() => { rmdir(tmpDir); });

    test('detector finds AzDo remote among mixed remotes', () => {
        const repo = repoAt(tmpDir);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.ok(detector.currentRemoteInfo);
        assert.strictEqual(detector.currentRemoteInfo!.remoteName, 'azure');
        assert.strictEqual(detector.currentRemoteInfo!.organization, 'myorg');
        detector.dispose();
    });

    test('file URI uses repo with AzDo remote, not GitHub remote', () => {
        const repo = repoAt(tmpDir);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);

        const thread = controller.createDraftThread('file.ts', 1, 'test');
        assert.ok(thread);
        assert.ok(fs.existsSync(thread!.uri.fsPath), `File should exist at: ${thread!.uri.fsPath}`);

        controller.dispose();
        detector.dispose();
    });
});

// ---------------------------------------------------------------------------
// Test: SSH remote format on real repo
// ---------------------------------------------------------------------------

suite('Integration: SSH remote — detection + resolution', () => {
    let tmpDir: string;
    const SSH_URL = 'git@ssh.dev.azure.com:v3/sshorg/sshproj/sshrepo';

    setup(() => {
        tmpDir = makeTempDir('azdo-test-ssh-');
        git(tmpDir, 'init');
        git(tmpDir, 'remote', 'add', 'origin', SSH_URL);
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'const app = 1;');
    });

    teardown(() => { rmdir(tmpDir); });

    test('detector parses SSH remote correctly', () => {
        const repo = repoAt(tmpDir);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.ok(detector.currentRemoteInfo);
        assert.strictEqual(detector.currentRemoteInfo!.organization, 'sshorg');
        assert.strictEqual(detector.currentRemoteInfo!.project, 'sshproj');
        assert.strictEqual(detector.currentRemoteInfo!.repositoryName, 'sshrepo');
        // apiBaseUrl should still be normalized to https
        assert.strictEqual(detector.currentRemoteInfo!.apiBaseUrl, 'https://dev.azure.com/sshorg');
        detector.dispose();
    });

    test('file URI resolves correctly with SSH remote', () => {
        const repo = repoAt(tmpDir);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);

        const thread = controller.createDraftThread('src/app.ts', 1, 'test');
        assert.ok(thread);
        assert.ok(fs.existsSync(thread!.uri.fsPath), `File should exist at: ${thread!.uri.fsPath}`);

        controller.dispose();
        detector.dispose();
    });
});
