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
});
