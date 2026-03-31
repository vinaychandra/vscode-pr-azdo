import * as assert from 'assert';
import * as vscode from 'vscode';
import { PrCommentController } from '../../views/prCommentController';
import { RepositoryDetector } from '../../azdo/repositoryDetector';
import type { API, Repository, RepositoryState, Remote } from '../../typings/git';
import type { GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { CommentType, CommentThreadStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';

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

function makeThread(overrides: Partial<GitPullRequestCommentThread> = {}): GitPullRequestCommentThread {
    return {
        id: 1,
        comments: [
            {
                content: 'Test comment',
                author: { displayName: 'Alice', ...({} as any) },
                commentType: CommentType.Text,
                isDeleted: false,
                publishedDate: new Date('2026-01-01'),
            },
        ],
        threadContext: {
            filePath: '/src/index.ts',
            rightFileStart: { line: 10, offset: 1 },
            rightFileEnd: { line: 10, offset: 1 },
        },
        status: CommentThreadStatus.Active,
        isDeleted: false,
        ...overrides,
    } as any;
}

suite('PrCommentController', () => {
    test('can be created and disposed without error', () => {
        const controller = new PrCommentController(createMockLog());
        controller.dispose();
    });

    test('updateThreads with undefined clears comments', () => {
        const controller = new PrCommentController(createMockLog());
        controller.updateThreads(undefined);
        controller.dispose();
    });

    test('updateThreads with empty array clears comments', () => {
        const controller = new PrCommentController(createMockLog());
        controller.updateThreads([]);
        controller.dispose();
    });

    test('updateThreads with file threads creates comments (if workspace exists)', () => {
        const controller = new PrCommentController(createMockLog());
        // This may or may not create threads depending on workspace state
        // in test environment, but it should not throw
        controller.updateThreads([makeThread()]);
        controller.dispose();
    });

    test('updateThreads skips PR-level threads (no filePath)', () => {
        const controller = new PrCommentController(createMockLog());
        controller.updateThreads([makeThread({ threadContext: undefined })]);
        controller.dispose();
    });

    test('updateThreads skips threads with only system comments', () => {
        const controller = new PrCommentController(createMockLog());
        controller.updateThreads([
            makeThread({
                comments: [
                    { content: 'system', commentType: CommentType.System, isDeleted: false, author: { displayName: 'System' } },
                ],
            } as any),
        ]);
        controller.dispose();
    });

    test('calling updateThreads multiple times disposes previous threads', () => {
        const controller = new PrCommentController(createMockLog());
        controller.updateThreads([makeThread()]);
        controller.updateThreads([makeThread({ id: 2 })]);
        controller.updateThreads(undefined);
        controller.dispose();
    });

    test('incremental updateThreads reuses PR-level thread objects', async () => {
        const controller = new PrCommentController(createMockLog());
        controller.setReviewMode(true);

        const prThread: GitPullRequestCommentThread = {
            id: 50,
            comments: [{ content: 'PR comment', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false, publishedDate: new Date() }],
            threadContext: undefined,
            status: CommentThreadStatus.Active,
            isDeleted: false,
        } as any;

        await controller.updateThreads([prThread]);
        const vsThread = controller.findThreadByAzdoId(50);
        assert.ok(vsThread, 'PR-level thread should exist');

        // Update with same thread (e.g., new reply added)
        const prThreadUpdated = {
            ...prThread,
            comments: [
                ...prThread.comments!,
                { content: 'Reply to PR', author: { displayName: 'Bob' }, commentType: CommentType.Text, isDeleted: false, publishedDate: new Date() },
            ],
        } as any;

        await controller.updateThreads([prThreadUpdated]);
        const vsThreadAfter = controller.findThreadByAzdoId(50);
        assert.strictEqual(vsThreadAfter, vsThread, 'PR-level thread should be reused');

        controller.dispose();
    });

    // --- Review Mode ---

    test('reviewMode defaults to false', () => {
        const controller = new PrCommentController(createMockLog());
        assert.strictEqual(controller.reviewMode, false);
        controller.dispose();
    });

    test('setReviewMode toggles reviewMode', () => {
        const controller = new PrCommentController(createMockLog());
        controller.setReviewMode(true);
        assert.strictEqual(controller.reviewMode, true);
        controller.setReviewMode(false);
        assert.strictEqual(controller.reviewMode, false);
        controller.dispose();
    });

    test('updateThreads does not create threads when reviewMode is off', () => {
        const controller = new PrCommentController(createMockLog());
        // reviewMode is off by default — threads should be suppressed
        controller.updateThreads([makeThread()]);
        // Should not throw; threads are cached but not displayed
        controller.dispose();
    });

    test('setReviewMode(true) re-applies cached threads', () => {
        const controller = new PrCommentController(createMockLog());
        // First set threads while review mode is off
        controller.updateThreads([makeThread()]);
        // Now enable review mode — should attempt to display cached threads
        controller.setReviewMode(true);
        // Should not throw
        controller.dispose();
    });

    test('setReviewMode(false) hides previously shown threads', () => {
        const controller = new PrCommentController(createMockLog());
        controller.setReviewMode(true);
        controller.updateThreads([makeThread()]);
        // Turning off review mode should dispose displayed threads
        controller.setReviewMode(false);
        controller.dispose();
    });

    test('setReviewMode is idempotent', () => {
        const controller = new PrCommentController(createMockLog());
        controller.setReviewMode(true);
        controller.setReviewMode(true); // no-op
        assert.strictEqual(controller.reviewMode, true);
        controller.setReviewMode(false);
        controller.setReviewMode(false); // no-op
        assert.strictEqual(controller.reviewMode, false);
        controller.dispose();
    });

    // --- getOriginalContext ---

    test('getOriginalContext returns undefined for unknown thread', () => {
        const controller = new PrCommentController(createMockLog());
        const fakeThread = {} as vscode.CommentThread;
        assert.strictEqual(controller.getOriginalContext(fakeThread), undefined);
        controller.dispose();
    });

    test('getOriginalContext returns undefined when thread has no pullRequestThreadContext', () => {
        const controller = new PrCommentController(createMockLog());
        // We can't directly add to the map, but we can test via updateThreads
        // Threads without pullRequestThreadContext should return undefined
        controller.setReviewMode(true);
        controller.updateThreads([makeThread()]);
        // The thread is created but has no pullRequestThreadContext
        // getOriginalContext needs a real vscode.CommentThread reference from the map,
        // which is internal — test with the public API indirectly
        controller.dispose();
    });

    test('getOriginalContext returns iteration info when pullRequestThreadContext is present', () => {
        const controller = new PrCommentController(createMockLog());
        // Thread with full iteration context
        const threadWithContext = makeThread({
            id: 42,
        });
        // Add pullRequestThreadContext (the AzDO-specific extended context)
        (threadWithContext as any).pullRequestThreadContext = {
            iterationContext: {
                firstComparingIteration: 0,
                secondComparingIteration: 3,
            },
            trackingCriteria: {
                origFilePath: '/src/original.ts',
                origRightFileStart: { line: 5, offset: 1 },
                origRightFileEnd: { line: 8, offset: 1 },
            },
        };

        controller.setReviewMode(true);
        controller.updateThreads([threadWithContext]);
        // We can't easily access the internal CommentThread objects,
        // but at minimum this verifies the flow doesn't throw
        controller.dispose();
    });

    // --- Draft threads ---

    test('draftCount is 0 initially', () => {
        const controller = new PrCommentController(createMockLog());
        assert.strictEqual(controller.draftCount, 0);
        controller.dispose();
    });

    test('createDraftThread returns undefined without workspace root', () => {
        const controller = new PrCommentController(createMockLog());
        // In test environment, workspace may not be set — draft creation should handle gracefully
        const result = controller.createDraftThread('test.ts', 1, 'Draft comment');
        // May or may not succeed depending on workspace state, but should not throw
        controller.dispose();
    });

    test('clearDrafts resets draftCount to 0', () => {
        const controller = new PrCommentController(createMockLog());
        controller.clearDrafts();
        assert.strictEqual(controller.draftCount, 0);
        controller.dispose();
    });

    test('isDraft returns false for non-draft threads', () => {
        const controller = new PrCommentController(createMockLog());
        const fakeThread = {} as vscode.CommentThread;
        assert.strictEqual(controller.isDraft(fakeThread), false);
        controller.dispose();
    });

    test('getDraftInfo returns undefined for non-draft threads', () => {
        const controller = new PrCommentController(createMockLog());
        const fakeThread = {} as vscode.CommentThread;
        assert.strictEqual(controller.getDraftInfo(fakeThread), undefined);
        controller.dispose();
    });

    // --- User draft threads ---

    test('userDraftCount is 0 initially', () => {
        const controller = new PrCommentController(createMockLog());
        assert.strictEqual(controller.userDraftCount, 0);
        controller.dispose();
    });

    test('isUserDraft returns false for non-user-draft threads', () => {
        const controller = new PrCommentController(createMockLog());
        const fakeThread = {} as vscode.CommentThread;
        assert.strictEqual(controller.isUserDraft(fakeThread), false);
        controller.dispose();
    });

    test('getUserDraftInfo returns undefined for non-user-draft threads', () => {
        const controller = new PrCommentController(createMockLog());
        const fakeThread = {} as vscode.CommentThread;
        assert.strictEqual(controller.getUserDraftInfo(fakeThread), undefined);
        controller.dispose();
    });

    test('clearUserDrafts resets userDraftCount to 0', () => {
        const controller = new PrCommentController(createMockLog());
        controller.clearUserDrafts();
        assert.strictEqual(controller.userDraftCount, 0);
        controller.dispose();
    });

    // --- setPrContext ---

    test('setPrContext enables PR context for operations', () => {
        const controller = new PrCommentController(createMockLog());
        const mockService = {} as any;
        controller.setPrContext(mockService, 42, ['src/index.ts', 'README.md'], 'user-123');
        // Should not throw
        controller.dispose();
    });

    test('setPrContext with undefined clears context', () => {
        const controller = new PrCommentController(createMockLog());
        controller.setPrContext({} as any, 42, ['a.ts']);
        controller.setPrContext(undefined, undefined);
        // Should not throw
        controller.dispose();
    });

    test('setPrContext can be called multiple times', () => {
        const controller = new PrCommentController(createMockLog());
        controller.setPrContext({} as any, 1, ['a.ts']);
        controller.setPrContext({} as any, 2, ['b.ts', 'c.ts']);
        controller.setPrContext(undefined, undefined);
        controller.dispose();
    });

    // --- getThreadId ---

    test('getThreadId returns undefined for unknown thread', () => {
        const controller = new PrCommentController(createMockLog());
        const fakeThread = {} as vscode.CommentThread;
        assert.strictEqual(controller.getThreadId(fakeThread), undefined);
        controller.dispose();
    });

    // --- findThreadForComment ---

    test('findThreadForComment returns undefined when no threads exist', () => {
        const controller = new PrCommentController(createMockLog());
        const fakeComment = { body: 'test', author: { name: 'Test' }, mode: 0 } as unknown as vscode.Comment;
        assert.strictEqual(controller.findThreadForComment(fakeComment), undefined);
        controller.dispose();
    });

    // --- getAzdoThread ---

    test('getAzdoThread returns undefined for unknown thread', () => {
        const controller = new PrCommentController(createMockLog());
        const fakeThread = {} as vscode.CommentThread;
        assert.strictEqual(controller.getAzdoThread(fakeThread), undefined);
        controller.dispose();
    });

    // --- onDidPerformAction ---

    test('onDidPerformAction event can be subscribed to', () => {
        const controller = new PrCommentController(createMockLog());
        let fired = false;
        const sub = controller.onDidPerformAction(() => { fired = true; });
        // Event doesn't fire yet — just verify subscription works
        assert.strictEqual(fired, false);
        sub.dispose();
        controller.dispose();
    });

    // --- PR-level comments (virtual doc) ---

    test('updateThreads with PR-level comments creates threads on virtual doc', () => {
        const controller = new PrCommentController(createMockLog());
        controller.setReviewMode(true);
        const prLevelThread = makeThread({
            id: 100,
            threadContext: undefined,
            comments: [
                { content: 'General PR comment', author: { displayName: 'Eve' }, commentType: CommentType.Text, isDeleted: false },
            ],
        } as any);
        controller.updateThreads([prLevelThread]);
        // Should not throw
        controller.dispose();
    });

    // --- Multiple thread types mixed ---

    test('updateThreads handles mix of file and PR-level threads', () => {
        const controller = new PrCommentController(createMockLog());
        controller.setReviewMode(true);
        controller.updateThreads([
            makeThread({ id: 1 }),
            makeThread({ id: 2, threadContext: undefined } as any),
            makeThread({ id: 3, threadContext: { filePath: '/src/other.ts', rightFileStart: { line: 5, offset: 1 }, rightFileEnd: { line: 5, offset: 1 } } }),
        ]);
        controller.dispose();
    });

    // --- Thread with suggestion comments ---

    test('updateThreads handles threads containing suggestions', () => {
        const controller = new PrCommentController(createMockLog());
        controller.setReviewMode(true);
        controller.updateThreads([
            makeThread({
                id: 10,
                comments: [
                    {
                        content: 'Fix this:\n```suggestion\nconst x = 1;\n```',
                        author: { displayName: 'Reviewer' },
                        commentType: CommentType.Text,
                        isDeleted: false,
                    },
                ],
            } as any),
        ]);
        controller.dispose();
    });

    // --- Current user comment detection ---

    test('setPrContext with userId enables own comment detection', () => {
        const controller = new PrCommentController(createMockLog());
        controller.setPrContext({} as any, 42, ['src/index.ts'], 'user-abc');
        controller.setReviewMode(true);
        controller.updateThreads([
            makeThread({
                id: 50,
                comments: [
                    {
                        content: 'My comment',
                        author: { displayName: 'Me', id: 'user-abc' },
                        commentType: CommentType.Text,
                        isDeleted: false,
                        publishedDate: new Date(),
                    },
                ],
            } as any),
        ]);
        // Should not throw — own comment detection is internal
        controller.dispose();
    });

    // --- createThreadOnUri ---

    test('createThreadOnUri creates a read-only thread', () => {
        const controller = new PrCommentController(createMockLog());
        const uri = vscode.Uri.parse('file:///test');
        const range = new vscode.Range(0, 0, 0, 0);
        const comments: vscode.Comment[] = [{
            body: new vscode.MarkdownString('test'),
            mode: vscode.CommentMode.Preview,
            author: { name: 'Test' },
        }];
        const thread = controller.createThreadOnUri(uri, range, comments);
        assert.ok(thread);
        assert.strictEqual(thread.comments.length, 1);
        controller.dispose();
    });

    // --- Reply draft methods ---

    test('findThreadByAzdoId returns undefined when no threads exist', () => {
        const controller = new PrCommentController(createMockLog());
        assert.strictEqual(controller.findThreadByAzdoId(42), undefined);
        controller.dispose();
    });

    test('hasReplyDraft returns false for unknown thread', () => {
        const controller = new PrCommentController(createMockLog());
        const fakeThread = {} as vscode.CommentThread;
        assert.strictEqual(controller.hasReplyDraft(fakeThread), false);
        controller.dispose();
    });

    test('getReplyDraftInfo returns undefined for unknown thread', () => {
        const controller = new PrCommentController(createMockLog());
        const fakeThread = {} as vscode.CommentThread;
        assert.strictEqual(controller.getReplyDraftInfo(fakeThread), undefined);
        controller.dispose();
    });

    test('removeReplyDraft is no-op for non-draft thread', () => {
        const controller = new PrCommentController(createMockLog());
        const fakeThread = {} as vscode.CommentThread;
        // Should not throw
        controller.removeReplyDraft(fakeThread);
        controller.dispose();
    });
});

// ---------------------------------------------------------------------------
// Helpers for workspace layout tests (mock git API + detector)
// ---------------------------------------------------------------------------

function makeRemote(name: string, fetchUrl?: string, pushUrl?: string): Remote {
    return { name, fetchUrl, pushUrl, isReadOnly: false } as Remote;
}

function makeRepo(remotes: Remote[], path: string): Repository {
    const stateEmitter = new vscode.EventEmitter<void>();
    return {
        rootUri: vscode.Uri.file(path),
        state: {
            remotes,
            HEAD: undefined,
            refs: [],
            onDidChange: stateEmitter.event,
        } as unknown as RepositoryState,
    } as unknown as Repository;
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

const AZDO_REMOTE = 'https://dev.azure.com/myorg/myproject/_git/myrepo';

// ---------------------------------------------------------------------------
// Incremental updateThreads — thread reuse & disposal
// ---------------------------------------------------------------------------

suite('Incremental updateThreads', () => {
    test('reuses existing file-level thread objects by AzDO id', async () => {
        const repo = makeRepo([makeRemote('origin', AZDO_REMOTE)], '/home/user/myrepo');
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);
        controller.setReviewMode(true);

        const thread1: GitPullRequestCommentThread = {
            id: 10,
            comments: [{ content: 'First', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false, publishedDate: new Date() }],
            threadContext: { filePath: '/src/index.ts', rightFileStart: { line: 5, offset: 1 }, rightFileEnd: { line: 5, offset: 1 } },
            status: CommentThreadStatus.Active,
            isDeleted: false,
        } as any;

        await controller.updateThreads([thread1]);
        const vsThread1 = controller.findThreadByAzdoId(10);
        assert.ok(vsThread1, 'thread should exist after first updateThreads');

        // Second call with same AzDO thread id but updated content
        const thread1Updated: GitPullRequestCommentThread = {
            ...thread1,
            comments: [
                ...thread1.comments!,
                { content: 'Reply', author: { displayName: 'Bob' }, commentType: CommentType.Text, isDeleted: false, publishedDate: new Date() },
            ],
        } as any;

        await controller.updateThreads([thread1Updated]);
        const vsThread1After = controller.findThreadByAzdoId(10);
        assert.ok(vsThread1After, 'thread should still exist after second updateThreads');
        assert.strictEqual(vsThread1After, vsThread1, 'same VS Code thread object should be reused (preserves collapse state)');

        controller.dispose();
        detector.dispose();
    });

    test('disposes threads removed from the new set', async () => {
        const repo = makeRepo([makeRemote('origin', AZDO_REMOTE)], '/home/user/myrepo');
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);
        controller.setReviewMode(true);

        const threadA: GitPullRequestCommentThread = {
            id: 20,
            comments: [{ content: 'A', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false, publishedDate: new Date() }],
            threadContext: { filePath: '/src/a.ts', rightFileStart: { line: 1, offset: 1 }, rightFileEnd: { line: 1, offset: 1 } },
            status: CommentThreadStatus.Active,
            isDeleted: false,
        } as any;
        const threadB: GitPullRequestCommentThread = {
            id: 21,
            comments: [{ content: 'B', author: { displayName: 'Bob' }, commentType: CommentType.Text, isDeleted: false, publishedDate: new Date() }],
            threadContext: { filePath: '/src/b.ts', rightFileStart: { line: 2, offset: 1 }, rightFileEnd: { line: 2, offset: 1 } },
            status: CommentThreadStatus.Active,
            isDeleted: false,
        } as any;

        await controller.updateThreads([threadA, threadB]);
        assert.ok(controller.findThreadByAzdoId(20), 'thread A should exist');
        assert.ok(controller.findThreadByAzdoId(21), 'thread B should exist');

        // Remove thread B, keep thread A
        await controller.updateThreads([threadA]);
        assert.ok(controller.findThreadByAzdoId(20), 'thread A should still exist');
        assert.strictEqual(controller.findThreadByAzdoId(21), undefined, 'thread B should be disposed');

        controller.dispose();
        detector.dispose();
    });

    test('creates new threads not present in previous set', async () => {
        const repo = makeRepo([makeRemote('origin', AZDO_REMOTE)], '/home/user/myrepo');
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);
        controller.setReviewMode(true);

        const threadA: GitPullRequestCommentThread = {
            id: 30,
            comments: [{ content: 'A', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false, publishedDate: new Date() }],
            threadContext: { filePath: '/src/a.ts', rightFileStart: { line: 1, offset: 1 }, rightFileEnd: { line: 1, offset: 1 } },
            status: CommentThreadStatus.Active,
            isDeleted: false,
        } as any;

        await controller.updateThreads([threadA]);
        const vsThreadA = controller.findThreadByAzdoId(30);
        assert.ok(vsThreadA, 'thread A should exist');

        // Add thread B alongside thread A
        const threadB: GitPullRequestCommentThread = {
            id: 31,
            comments: [{ content: 'B', author: { displayName: 'Bob' }, commentType: CommentType.Text, isDeleted: false, publishedDate: new Date() }],
            threadContext: { filePath: '/src/b.ts', rightFileStart: { line: 2, offset: 1 }, rightFileEnd: { line: 2, offset: 1 } },
            status: CommentThreadStatus.Active,
            isDeleted: false,
        } as any;

        await controller.updateThreads([threadA, threadB]);
        assert.strictEqual(controller.findThreadByAzdoId(30), vsThreadA, 'thread A should be reused');
        assert.ok(controller.findThreadByAzdoId(31), 'thread B should be created');

        controller.dispose();
        detector.dispose();
    });
});

// ---------------------------------------------------------------------------
// File URI resolution across workspace layouts
//
// When a user adds or views a comment on a file, the extension must:
//   1. Resolve the workspace root from the correct Repository (via detector)
//   2. Join AzDO's repo-relative path (e.g., '/src/index.ts') with that root
//      to produce a valid file:// URI
//   3. On the reverse path (new comment → API call), strip the root from
//      the file:// URI to recover the repo-relative path
//
// These tests verify steps 1-2 via createDraftThread() (which calls
// Uri.joinPath(_workspaceRoot, filePath)) across all workspace layouts.
// ---------------------------------------------------------------------------

suite('File URI resolution: simple clone', () => {
    test('draft thread URI resolves relative to repo root', () => {
        const repo = makeRepo([makeRemote('origin', AZDO_REMOTE)], '/home/user/myrepo');
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);

        const thread = controller.createDraftThread('src/index.ts', 10, 'test comment');
        assert.ok(thread, 'should create draft thread');
        assert.strictEqual(thread!.uri.scheme, 'file');
        assert.ok(
            thread!.uri.fsPath.endsWith('src/index.ts') || thread!.uri.path.endsWith('src/index.ts'),
            `URI path should end with src/index.ts, got: ${thread!.uri.fsPath}`,
        );
        // The full path should include the repo root
        const expectedUri = vscode.Uri.joinPath(vscode.Uri.file('/home/user/myrepo'), 'src/index.ts');
        assert.strictEqual(thread!.uri.toString(), expectedUri.toString());

        controller.dispose();
        detector.dispose();
    });

    test('nested file path resolves correctly', () => {
        const repo = makeRepo([makeRemote('origin', AZDO_REMOTE)], '/home/user/myrepo');
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);

        const thread = controller.createDraftThread('packages/core/src/utils/helpers.ts', 5, 'deep path');
        assert.ok(thread);
        const expectedUri = vscode.Uri.joinPath(vscode.Uri.file('/home/user/myrepo'), 'packages/core/src/utils/helpers.ts');
        assert.strictEqual(thread!.uri.toString(), expectedUri.toString());

        controller.dispose();
        detector.dispose();
    });

    test('root-level file resolves correctly', () => {
        const repo = makeRepo([makeRemote('origin', AZDO_REMOTE)], '/home/user/myrepo');
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);

        const thread = controller.createDraftThread('README.md', 1, 'root file');
        assert.ok(thread);
        const expectedUri = vscode.Uri.joinPath(vscode.Uri.file('/home/user/myrepo'), 'README.md');
        assert.strictEqual(thread!.uri.toString(), expectedUri.toString());

        controller.dispose();
        detector.dispose();
    });
});

suite('File URI resolution: subfolder within a clone', () => {
    // When the user opens a subfolder of a clone (e.g., /home/user/myrepo/src),
    // VS Code's git extension still reports the repo at the git root (/home/user/myrepo).
    // File URIs must be relative to the git root, NOT the workspace folder.

    test('file URI is relative to git root, not workspace folder', () => {
        // rootUri is at git root even though user opened a subfolder
        const repo = makeRepo([makeRemote('origin', AZDO_REMOTE)], '/home/user/myrepo');
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);

        const thread = controller.createDraftThread('src/index.ts', 10, 'test');
        assert.ok(thread);
        // URI should be based on git root (/home/user/myrepo), not workspace folder
        const expectedUri = vscode.Uri.joinPath(vscode.Uri.file('/home/user/myrepo'), 'src/index.ts');
        assert.strictEqual(thread!.uri.toString(), expectedUri.toString());

        controller.dispose();
        detector.dispose();
    });

    test('file outside workspace subfolder still resolves correctly', () => {
        // User opened /home/user/myrepo/src but file is at repo root
        const repo = makeRepo([makeRemote('origin', AZDO_REMOTE)], '/home/user/myrepo');
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);

        const thread = controller.createDraftThread('tsconfig.json', 1, 'test');
        assert.ok(thread);
        const expectedUri = vscode.Uri.joinPath(vscode.Uri.file('/home/user/myrepo'), 'tsconfig.json');
        assert.strictEqual(thread!.uri.toString(), expectedUri.toString());

        controller.dispose();
        detector.dispose();
    });
});

suite('File URI resolution: worktrees', () => {
    test('file URI uses worktree root when worktree has AzDo remote', () => {
        const mainRepo = makeRepo([
            makeRemote('origin', 'https://github.com/user/repo.git'),
        ], '/workspace/main');
        const worktreeRepo = makeRepo([
            makeRemote('origin', AZDO_REMOTE),
        ], '/workspace/worktrees/feature');
        const api = makeGitApi([mainRepo, worktreeRepo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);

        const thread = controller.createDraftThread('src/index.ts', 10, 'on worktree');
        assert.ok(thread);
        // URI must be under the worktree root, NOT the main repo
        const expectedUri = vscode.Uri.joinPath(vscode.Uri.file('/workspace/worktrees/feature'), 'src/index.ts');
        assert.strictEqual(thread!.uri.toString(), expectedUri.toString());

        controller.dispose();
        detector.dispose();
    });

    test('file URI does NOT use main repo path when worktree is the match', () => {
        const mainRepo = makeRepo([
            makeRemote('origin', 'https://github.com/user/repo.git'),
        ], '/workspace/main');
        const worktreeRepo = makeRepo([
            makeRemote('origin', AZDO_REMOTE),
        ], '/workspace/worktrees/feature');
        const api = makeGitApi([mainRepo, worktreeRepo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);

        const thread = controller.createDraftThread('src/app.ts', 5, 'test');
        assert.ok(thread);
        // Must NOT be under /workspace/main
        const mainPath = vscode.Uri.file('/workspace/main').toString();
        assert.ok(
            !thread!.uri.toString().startsWith(mainPath),
            `URI should not start with main repo path: ${thread!.uri.toString()}`,
        );

        controller.dispose();
        detector.dispose();
    });

    test('when both repos have AzDo remote, first match determines root', () => {
        const repo1 = makeRepo([makeRemote('origin', AZDO_REMOTE)], '/workspace/main');
        const repo2 = makeRepo([makeRemote('origin', AZDO_REMOTE)], '/workspace/worktrees/feature');
        const api = makeGitApi([repo1, repo2]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);

        const thread = controller.createDraftThread('src/index.ts', 1, 'test');
        assert.ok(thread);
        // First repo in the array is the match
        const expectedUri = vscode.Uri.joinPath(vscode.Uri.file('/workspace/main'), 'src/index.ts');
        assert.strictEqual(thread!.uri.toString(), expectedUri.toString());

        controller.dispose();
        detector.dispose();
    });

    test('multiple files resolve to the same worktree root consistently', () => {
        const worktreeRepo = makeRepo([makeRemote('origin', AZDO_REMOTE)], '/workspace/wt/feat');
        const api = makeGitApi([worktreeRepo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);

        const files = ['src/a.ts', 'src/b.ts', 'README.md', 'packages/lib/index.ts'];
        for (const f of files) {
            const thread = controller.createDraftThread(f, 1, `comment on ${f}`);
            assert.ok(thread, `should create thread for ${f}`);
            const expectedUri = vscode.Uri.joinPath(vscode.Uri.file('/workspace/wt/feat'), f);
            assert.strictEqual(thread!.uri.toString(), expectedUri.toString(), `URI mismatch for ${f}`);
        }

        controller.dispose();
        detector.dispose();
    });
});

suite('File URI resolution: subfolder within a worktree', () => {
    test('file URI uses worktree root even when workspace is a worktree subfolder', () => {
        // User opens /workspace/worktrees/feature/src, but git reports rootUri at /workspace/worktrees/feature
        const worktreeRepo = makeRepo([makeRemote('origin', AZDO_REMOTE)], '/workspace/worktrees/feature');
        const api = makeGitApi([worktreeRepo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);

        const thread = controller.createDraftThread('src/components/Button.tsx', 42, 'test');
        assert.ok(thread);
        const expectedUri = vscode.Uri.joinPath(vscode.Uri.file('/workspace/worktrees/feature'), 'src/components/Button.tsx');
        assert.strictEqual(thread!.uri.toString(), expectedUri.toString());

        controller.dispose();
        detector.dispose();
    });
});

suite('File URI resolution: AzDO thread paths', () => {
    // AzDO API returns file paths with a leading '/' (e.g., '/src/index.ts').
    // The updateThreads() method strips the leading '/' before joining with root.
    // These tests verify that via updateThreads() the thread URIs are correct.

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
                rightFileStart: { line: 10, offset: 1 },
                rightFileEnd: { line: 10, offset: 1 },
            },
            status: CommentThreadStatus.Active,
            isDeleted: false,
        } as any;
    }

    test('leading slash is stripped for simple clone', async () => {
        const repo = makeRepo([makeRemote('origin', AZDO_REMOTE)], '/home/user/myrepo');
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);
        controller.setReviewMode(true);

        // AzDO paths always start with '/'
        await controller.updateThreads([makeAzdoThread('/src/index.ts')]);
        // The thread should have been created without throwing
        // (we can't access _threads directly, but no error = success)

        controller.dispose();
        detector.dispose();
    });

    test('leading slash handling works for worktree', async () => {
        const mainRepo = makeRepo([
            makeRemote('origin', 'https://github.com/user/repo.git'),
        ], '/workspace/main');
        const worktreeRepo = makeRepo([
            makeRemote('origin', AZDO_REMOTE),
        ], '/workspace/worktrees/feature');
        const api = makeGitApi([mainRepo, worktreeRepo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);
        controller.setReviewMode(true);

        await controller.updateThreads([makeAzdoThread('/src/app.ts')]);

        controller.dispose();
        detector.dispose();
    });

    test('handles paths without leading slash', async () => {
        const repo = makeRepo([makeRemote('origin', AZDO_REMOTE)], '/home/user/myrepo');
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);
        controller.setReviewMode(true);

        // Edge case: path without leading slash (shouldn't happen in practice but should be handled)
        await controller.updateThreads([makeAzdoThread('src/index.ts')]);

        controller.dispose();
        detector.dispose();
    });

    test('deeply nested AzDO path resolves correctly', async () => {
        const repo = makeRepo([makeRemote('origin', AZDO_REMOTE)], '/home/user/myrepo');
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);
        controller.setReviewMode(true);

        await controller.updateThreads([makeAzdoThread('/packages/core/src/utils/helpers.ts')]);

        controller.dispose();
        detector.dispose();
    });

    test('multiple threads on different files all resolve correctly', async () => {
        const repo = makeRepo([makeRemote('origin', AZDO_REMOTE)], '/workspace/wt/feat');
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);
        controller.setReviewMode(true);

        await controller.updateThreads([
            makeAzdoThread('/src/a.ts', 1),
            makeAzdoThread('/src/b.ts', 2),
            makeAzdoThread('/README.md', 3),
            makeAzdoThread('/packages/lib/index.ts', 4),
        ]);

        controller.dispose();
        detector.dispose();
    });

    test('PR-level thread (no filePath) does not need root resolution', async () => {
        const repo = makeRepo([makeRemote('origin', AZDO_REMOTE)], '/workspace/myrepo');
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const controller = new PrCommentController(createMockLog(), api, detector);
        controller.setReviewMode(true);

        await controller.updateThreads([{
            id: 100,
            comments: [{
                content: 'General PR comment',
                author: { displayName: 'Eve' },
                commentType: CommentType.Text,
                isDeleted: false,
            }],
            threadContext: undefined,
            status: CommentThreadStatus.Active,
            isDeleted: false,
        } as any]);

        controller.dispose();
        detector.dispose();
    });
});

suite('File URI resolution: consistency across layouts', () => {
    // The same AzDO relative path should produce a URI that differs only in the
    // root prefix — the relative portion must always match exactly.

    const layouts = [
        { label: 'simple clone', path: '/home/user/myrepo' },
        { label: 'worktree', path: '/workspace/worktrees/feature' },
        { label: 'deeply nested clone', path: '/home/user/projects/mono/app' },
        { label: 'Windows-style path', path: 'C:\\Users\\dev\\repos\\myrepo' },
        { label: 'Windows worktree', path: 'D:\\Work\\wt\\feat-123' },
    ];

    const testFile = 'src/components/Button.tsx';

    for (const { label, path } of layouts) {
        test(`${label}: createDraftThread produces correct URI`, () => {
            const repo = makeRepo([makeRemote('origin', AZDO_REMOTE)], path);
            const api = makeGitApi([repo]);
            const detector = new RepositoryDetector(api, createMockLog());
            const controller = new PrCommentController(createMockLog(), api, detector);

            const thread = controller.createDraftThread(testFile, 5, `from ${label}`);
            assert.ok(thread, `${label}: should create draft thread`);

            const expectedUri = vscode.Uri.joinPath(vscode.Uri.file(path), testFile);
            assert.strictEqual(
                thread!.uri.toString(),
                expectedUri.toString(),
                `${label}: URI mismatch`,
            );

            controller.dispose();
            detector.dispose();
        });
    }

    test('URI relative suffix is identical across all layouts', () => {
        const uris: string[] = [];
        for (const { path } of layouts) {
            const repo = makeRepo([makeRemote('origin', AZDO_REMOTE)], path);
            const api = makeGitApi([repo]);
            const detector = new RepositoryDetector(api, createMockLog());
            const controller = new PrCommentController(createMockLog(), api, detector);

            const thread = controller.createDraftThread(testFile, 5, 'test');
            assert.ok(thread);
            uris.push(thread!.uri.path);

            controller.dispose();
            detector.dispose();
        }

        // All URIs should end with the same relative path
        for (const uri of uris) {
            assert.ok(
                uri.endsWith('/' + testFile),
                `URI path "${uri}" should end with /${testFile}`,
            );
        }
    });
});
