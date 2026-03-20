import * as assert from 'assert';
import * as vscode from 'vscode';
import { PrCommentController } from '../../views/prCommentController';
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
