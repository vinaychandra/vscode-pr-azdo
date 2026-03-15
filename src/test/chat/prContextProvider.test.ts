import * as assert from 'assert';
import { PrContextProvider } from '../../chat/prContextProvider';
import { CommentType, CommentThreadStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { GitPullRequestCommentThread, GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';

function makeThread(overrides: Partial<GitPullRequestCommentThread> = {}): GitPullRequestCommentThread {
    return {
        id: 1,
        comments: [
            {
                content: 'Please rename this variable',
                author: { displayName: 'Alice' },
                commentType: CommentType.Text,
                isDeleted: false,
                publishedDate: new Date('2026-01-15'),
            },
            {
                content: 'I agree, the name is confusing',
                author: { displayName: 'Bob' },
                commentType: CommentType.Text,
                isDeleted: false,
                publishedDate: new Date('2026-01-16'),
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

function makePr(): GitPullRequest {
    return {
        pullRequestId: 42,
        title: 'Add new feature',
        description: 'This PR adds X, Y, Z',
        sourceRefName: 'refs/heads/feature/new-thing',
        targetRefName: 'refs/heads/main',
        createdBy: { displayName: 'Alice' } as any,
    } as any;
}

suite('PrContextProvider — Comment Context', () => {
    test('initially has no comment context', () => {
        const provider = new PrContextProvider();
        assert.strictEqual(provider.peekCommentContext(), undefined);
        assert.strictEqual(provider.consumeCommentContext(), undefined);
    });

    test('setCommentContext stores context', () => {
        const provider = new PrContextProvider();
        const ctx = { thread: makeThread(), filePath: 'src/index.ts', startLine: 10, startCol: 1, endLine: 10, endCol: 1 };
        provider.setCommentContext(ctx);
        assert.strictEqual(provider.peekCommentContext(), ctx);
    });

    test('consumeCommentContext returns and clears context', () => {
        const provider = new PrContextProvider();
        const ctx = { thread: makeThread(), filePath: 'src/index.ts', startLine: 10, startCol: 1, endLine: 10, endCol: 1 };
        provider.setCommentContext(ctx);
        const consumed = provider.consumeCommentContext();
        assert.strictEqual(consumed, ctx);
        assert.strictEqual(provider.peekCommentContext(), undefined);
    });

    test('setCommentContext with undefined clears context', () => {
        const provider = new PrContextProvider();
        provider.setCommentContext({ thread: makeThread(), filePath: 'a.ts', startLine: 1, startCol: 1, endLine: 1, endCol: 1 });
        provider.setCommentContext(undefined);
        assert.strictEqual(provider.peekCommentContext(), undefined);
    });
});

suite('PrContextProvider — PR Context', () => {
    test('initially has no active PR', () => {
        const provider = new PrContextProvider();
        assert.strictEqual(provider.activePr, undefined);
        assert.deepStrictEqual(provider.changedFilePaths, []);
    });

    test('setActivePr stores PR and file paths', () => {
        const provider = new PrContextProvider();
        const pr = makePr();
        provider.setActivePr(pr, ['src/index.ts', 'README.md']);
        assert.strictEqual(provider.activePr, pr);
        assert.deepStrictEqual(provider.changedFilePaths, ['src/index.ts', 'README.md']);
    });

    test('setActivePr with undefined clears PR', () => {
        const provider = new PrContextProvider();
        provider.setActivePr(makePr(), ['a.ts']);
        provider.setActivePr(undefined);
        assert.strictEqual(provider.activePr, undefined);
        assert.deepStrictEqual(provider.changedFilePaths, []);
    });
});

suite('PrContextProvider — formatThreadForPrompt', () => {
    test('formats a thread with comments', () => {
        const provider = new PrContextProvider();
        const result = provider.formatThreadForPrompt(makeThread());
        assert.ok(result.includes('Comment Thread'));
        assert.ok(result.includes('src/index.ts'));
        assert.ok(!result.includes('/src/index.ts'), 'should strip leading slash from path');
        assert.ok(result.includes('L10'));
        assert.ok(result.includes('Col1'), 'should include column info');
        assert.ok(result.includes('Alice'));
        assert.ok(result.includes('Please rename this variable'));
        assert.ok(result.includes('Bob'));
        assert.ok(result.includes('I agree'));
        assert.ok(result.includes('Active'));
    });

    test('includes column range when start and end columns differ', () => {
        const provider = new PrContextProvider();
        const thread = makeThread({
            threadContext: {
                filePath: '/src/foo.ts',
                rightFileStart: { line: 5, offset: 10 },
                rightFileEnd: { line: 5, offset: 25 },
            },
        });
        const result = provider.formatThreadForPrompt(thread);
        assert.ok(result.includes('L5'), 'should include line');
        assert.ok(result.includes('Col10-25'), 'should include column range');
    });

    test('handles thread with no file context', () => {
        const provider = new PrContextProvider();
        const result = provider.formatThreadForPrompt(makeThread({ threadContext: undefined }));
        assert.ok(result.includes('PR-level comment'));
    });

    test('skips system and deleted comments', () => {
        const provider = new PrContextProvider();
        const thread = makeThread({
            comments: [
                { content: 'visible', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false } as any,
                { content: 'system msg', author: { displayName: 'System' }, commentType: CommentType.System, isDeleted: false } as any,
                { content: 'deleted', author: { displayName: 'Bob' }, commentType: CommentType.Text, isDeleted: true } as any,
            ],
        });
        const result = provider.formatThreadForPrompt(thread);
        assert.ok(result.includes('visible'));
        assert.ok(!result.includes('system msg'));
        assert.ok(!result.includes('deleted'));
    });
});

suite('PrContextProvider — formatPrForPrompt', () => {
    test('formats PR metadata', () => {
        const provider = new PrContextProvider();
        provider.setActivePr(makePr(), ['src/index.ts', 'README.md']);
        const result = provider.formatPrForPrompt();
        assert.ok(result.includes('#42'));
        assert.ok(result.includes('Add new feature'));
        assert.ok(result.includes('Alice'));
        assert.ok(result.includes('feature/new-thing'));
        assert.ok(result.includes('main'));
        assert.ok(result.includes('This PR adds X, Y, Z'));
        assert.ok(result.includes('src/index.ts'));
        assert.ok(result.includes('README.md'));
    });

    test('handles no active PR', () => {
        const provider = new PrContextProvider();
        const result = provider.formatPrForPrompt();
        assert.ok(result.includes('No active pull request'));
    });

    test('handles PR without description', () => {
        const provider = new PrContextProvider();
        const pr = makePr();
        pr.description = undefined;
        provider.setActivePr(pr);
        const result = provider.formatPrForPrompt();
        assert.ok(!result.includes('Description'));
    });
});
