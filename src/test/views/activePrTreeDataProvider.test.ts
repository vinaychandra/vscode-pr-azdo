import * as assert from 'assert';
import * as vscode from 'vscode';
import { ActivePrTreeDataProvider, type CommentFilter } from '../../views/activePrTreeDataProvider';
import { ActivePrRootItem, ReviewModeToggleItem } from '../../views/activePrTreeItems';
import { CommentThreadStatus, CommentType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { GitPullRequestCommentThread, GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { PullRequestService } from '../../azdo/prService';
import type { API, Repository, RepositoryState } from '../../typings/git';

// --- Helpers ---

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

function createMockPrService(overrides: Partial<PullRequestService> = {}): PullRequestService {
    return {
        findPrForBranch: async () => undefined,
        getPrIterations: async () => [],
        getPrIterationChanges: async () => ({ changeEntries: [] }),
        getPrCommits: async () => [],
        getPrThreads: async () => [],
        ...overrides,
    } as unknown as PullRequestService;
}

function createMockGitApi(branchName?: string): API {
    const state: RepositoryState = {
        HEAD: branchName ? { name: branchName } : undefined,
        onDidChange: new vscode.EventEmitter<void>().event,
    } as any;
    const repo: Repository = {
        state,
    } as any;
    return {
        repositories: [repo],
        onDidOpenRepository: new vscode.EventEmitter<Repository>().event,
    } as unknown as API;
}

function makeThread(overrides: Partial<GitPullRequestCommentThread> = {}): GitPullRequestCommentThread {
    return {
        id: 1,
        comments: [
            {
                content: 'Test comment',
                author: { displayName: 'Alice' },
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

// --- Tests ---

suite('ActivePrTreeDataProvider — Review Mode', () => {
    test('reviewMode defaults to false', () => {
        const provider = new ActivePrTreeDataProvider(
            createMockPrService(),
            createMockGitApi(),
            createMockLog(),
        );
        assert.strictEqual(provider.reviewMode, false);
        provider.dispose();
    });

    test('setReviewMode toggles reviewMode', () => {
        const provider = new ActivePrTreeDataProvider(
            createMockPrService(),
            createMockGitApi(),
            createMockLog(),
        );
        provider.setReviewMode(true);
        assert.strictEqual(provider.reviewMode, true);
        provider.setReviewMode(false);
        assert.strictEqual(provider.reviewMode, false);
        provider.dispose();
    });

    test('setReviewMode is idempotent — no double fire', () => {
        let fireCount = 0;
        const provider = new ActivePrTreeDataProvider(
            createMockPrService(),
            createMockGitApi(),
            createMockLog(),
        );
        provider.onDidChangeTreeData(() => { fireCount++; });
        provider.setReviewMode(true);
        assert.strictEqual(fireCount, 1);
        provider.setReviewMode(true); // same value — should not fire
        assert.strictEqual(fireCount, 1);
        provider.dispose();
    });

    test('setReviewMode fires onDidChangeTreeData and onDidUpdateComments', () => {
        let treeChanged = false;
        let commentsUpdated = false;
        const provider = new ActivePrTreeDataProvider(
            createMockPrService(),
            createMockGitApi(),
            createMockLog(),
        );
        provider.onDidChangeTreeData(() => { treeChanged = true; });
        provider.onDidUpdateComments(() => { commentsUpdated = true; });
        provider.setReviewMode(true);
        assert.ok(treeChanged, 'onDidChangeTreeData should fire');
        assert.ok(commentsUpdated, 'onDidUpdateComments should fire');
        provider.dispose();
    });

    test('filteredThreads returns [] when reviewMode is off', () => {
        const provider = new ActivePrTreeDataProvider(
            createMockPrService(),
            createMockGitApi(),
            createMockLog(),
        );
        // Can't directly set _allThreads, but filteredThreads should return []
        // since reviewMode is off
        assert.deepStrictEqual(provider.filteredThreads, []);
        provider.dispose();
    });
});

suite('ActivePrTreeDataProvider — Comment Filter', () => {
    test('commentFilter defaults to active', () => {
        const provider = new ActivePrTreeDataProvider(
            createMockPrService(),
            createMockGitApi(),
            createMockLog(),
        );
        assert.strictEqual(provider.commentFilter, 'active');
        provider.dispose();
    });

    test('setCommentFilter changes filter value', () => {
        const provider = new ActivePrTreeDataProvider(
            createMockPrService(),
            createMockGitApi(),
            createMockLog(),
        );
        provider.setCommentFilter('all');
        assert.strictEqual(provider.commentFilter, 'all');
        provider.setCommentFilter('active');
        assert.strictEqual(provider.commentFilter, 'active');
        provider.dispose();
    });

    test('setCommentFilter fires onDidChangeTreeData and onDidUpdateComments', () => {
        let treeChanged = false;
        let commentsUpdated = false;
        const provider = new ActivePrTreeDataProvider(
            createMockPrService(),
            createMockGitApi(),
            createMockLog(),
        );
        provider.onDidChangeTreeData(() => { treeChanged = true; });
        provider.onDidUpdateComments(() => { commentsUpdated = true; });
        provider.setCommentFilter('all');
        assert.ok(treeChanged, 'onDidChangeTreeData should fire');
        assert.ok(commentsUpdated, 'onDidUpdateComments should fire');
        provider.dispose();
    });
});

suite('ActivePrTreeDataProvider — getChildren with no active PR', () => {
    test('returns empty when no active PR', async () => {
        const provider = new ActivePrTreeDataProvider(
            createMockPrService(),
            createMockGitApi(), // no branch → no PR
            createMockLog(),
        );
        const roots = await provider.getChildren();
        assert.strictEqual(roots.length, 0);
        provider.dispose();
    });
});

suite('ActivePrTreeDataProvider — changedFilePaths', () => {
    test('returns empty when no data loaded', () => {
        const provider = new ActivePrTreeDataProvider(
            createMockPrService(),
            createMockGitApi(),
            createMockLog(),
        );
        assert.deepStrictEqual(provider.changedFilePaths, []);
        provider.dispose();
    });
});

suite('ActivePrTreeDataProvider — iterations', () => {
    test('iterations is undefined before data load', () => {
        const provider = new ActivePrTreeDataProvider(
            createMockPrService(),
            createMockGitApi(),
            createMockLog(),
        );
        assert.strictEqual(provider.iterations, undefined);
        provider.dispose();
    });
});

suite('ActivePrTreeDataProvider — dispose', () => {
    test('can be disposed without error', () => {
        const provider = new ActivePrTreeDataProvider(
            createMockPrService(),
            createMockGitApi(),
            createMockLog(),
        );
        provider.dispose();
    });
});

suite('ActivePrTreeDataProvider — Author Filter', () => {
    test('authorFilter defaults to null', () => {
        const provider = new ActivePrTreeDataProvider(
            createMockPrService(),
            createMockGitApi(),
            createMockLog(),
        );
        assert.strictEqual(provider.authorFilter, null);
        provider.dispose();
    });

    test('setAuthorFilter changes filter value', () => {
        const provider = new ActivePrTreeDataProvider(
            createMockPrService(),
            createMockGitApi(),
            createMockLog(),
        );
        provider.setAuthorFilter('Alice');
        assert.strictEqual(provider.authorFilter, 'Alice');
        provider.setAuthorFilter(null);
        assert.strictEqual(provider.authorFilter, null);
        provider.dispose();
    });

    test('setAuthorFilter fires onDidChangeTreeData and onDidUpdateComments', () => {
        let treeChanged = false;
        let commentsUpdated = false;
        const provider = new ActivePrTreeDataProvider(
            createMockPrService(),
            createMockGitApi(),
            createMockLog(),
        );
        provider.onDidChangeTreeData(() => { treeChanged = true; });
        provider.onDidUpdateComments(() => { commentsUpdated = true; });
        provider.setAuthorFilter('Alice');
        assert.ok(treeChanged, 'onDidChangeTreeData should fire');
        assert.ok(commentsUpdated, 'onDidUpdateComments should fire');
        provider.dispose();
    });

    test('getUniqueAuthors returns empty when no threads', () => {
        const provider = new ActivePrTreeDataProvider(
            createMockPrService(),
            createMockGitApi(),
            createMockLog(),
        );
        assert.deepStrictEqual(provider.getUniqueAuthors(), []);
        provider.dispose();
    });
});

// --- Integration tests that load threads via the PR service mock ---

/** Create a provider with an active PR and pre-loaded threads. */
async function createProviderWithThreads(threads: GitPullRequestCommentThread[]): Promise<ActivePrTreeDataProvider> {
    const pr: GitPullRequest = {
        pullRequestId: 42,
        title: 'Test PR',
        createdBy: { displayName: 'Owner', id: 'owner-id' },
        sourceRefName: 'refs/heads/feature',
        targetRefName: 'refs/heads/main',
        status: 1, // Active
    } as any;

    const provider = new ActivePrTreeDataProvider(
        createMockPrService({
            findPrForBranch: async () => pr,
            getPrIterations: async () => [{ id: 1 }] as any,
            getPrIterationChanges: async () => ({ changeEntries: [] }),
            getPrCommits: async () => [],
            getPrThreads: async () => threads,
        }),
        createMockGitApi('feature'),
        createMockLog(),
    );

    // Trigger detection + data loading
    await provider.detectActivePr();
    const roots = await provider.getChildren();
    // Expand the ActivePrRootItem (index 1, after ReviewModeToggleItem) to trigger ensureData → loadThreads
    const prRoot = roots.find(r => r instanceof ActivePrRootItem);
    if (prRoot) {
        await provider.getChildren(prRoot);
    }

    return provider;
}

suite('ActivePrTreeDataProvider — getUniqueAuthors with data', () => {
    test('returns sorted unique author names', async () => {
        const threads = [
            makeThread({ id: 1, comments: [{ content: 'a', author: { displayName: 'Charlie' }, commentType: CommentType.Text, isDeleted: false }] as any }),
            makeThread({ id: 2, comments: [{ content: 'b', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false }] as any }),
            makeThread({ id: 3, comments: [{ content: 'c', author: { displayName: 'Charlie' }, commentType: CommentType.Text, isDeleted: false }] as any }),
        ];
        const provider = await createProviderWithThreads(threads);
        const authors = provider.getUniqueAuthors();
        assert.deepStrictEqual(authors, ['Alice', 'Charlie']);
        provider.dispose();
    });

    test('skips deleted comments', async () => {
        const threads = [
            makeThread({
                id: 1, comments: [
                    { content: 'keep', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false },
                    { content: 'deleted', author: { displayName: 'Ghost' }, commentType: CommentType.Text, isDeleted: true },
                ] as any
            }),
        ];
        const provider = await createProviderWithThreads(threads);
        const authors = provider.getUniqueAuthors();
        assert.deepStrictEqual(authors, ['Alice']);
        provider.dispose();
    });

    test('skips system comments', async () => {
        const threads = [
            makeThread({
                id: 1, comments: [
                    { content: 'user', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false },
                    { content: 'system', author: { displayName: 'SystemBot' }, commentType: CommentType.System, isDeleted: false },
                ] as any
            }),
        ];
        const provider = await createProviderWithThreads(threads);
        const authors = provider.getUniqueAuthors();
        assert.deepStrictEqual(authors, ['Alice']);
        provider.dispose();
    });

    test('skips comments with no author displayName', async () => {
        const threads = [
            makeThread({
                id: 1, comments: [
                    { content: 'named', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false },
                    { content: 'no-name', author: {}, commentType: CommentType.Text, isDeleted: false },
                    { content: 'null-author', author: undefined, commentType: CommentType.Text, isDeleted: false },
                ] as any
            }),
        ];
        const provider = await createProviderWithThreads(threads);
        const authors = provider.getUniqueAuthors();
        assert.deepStrictEqual(authors, ['Alice']);
        provider.dispose();
    });

    test('handles thread with empty comments array', async () => {
        const threads = [
            makeThread({ id: 1, comments: [] as any }),
            makeThread({ id: 2, comments: [{ content: 'x', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false }] as any }),
        ];
        // The thread with empty comments will be filtered out by loadThreads (no user comment)
        const provider = await createProviderWithThreads(threads);
        const authors = provider.getUniqueAuthors();
        assert.deepStrictEqual(authors, ['Alice']);
        provider.dispose();
    });
});

suite('ActivePrTreeDataProvider — filteredThreads with author filter', () => {
    test('returns all threads when author filter is null', async () => {
        const threads = [
            makeThread({ id: 1, status: CommentThreadStatus.Active, comments: [{ content: 'a', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false }] as any }),
            makeThread({ id: 2, status: CommentThreadStatus.Active, comments: [{ content: 'b', author: { displayName: 'Bob' }, commentType: CommentType.Text, isDeleted: false }] as any }),
        ];
        const provider = await createProviderWithThreads(threads);
        provider.setReviewMode(true);
        provider.setCommentFilter('all');
        provider.setAuthorFilter(null);
        assert.strictEqual(provider.filteredThreads.length, 2);
        provider.dispose();
    });

    test('filters by author when set', async () => {
        const threads = [
            makeThread({ id: 1, status: CommentThreadStatus.Active, comments: [{ content: 'a', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false }] as any }),
            makeThread({ id: 2, status: CommentThreadStatus.Active, comments: [{ content: 'b', author: { displayName: 'Bob' }, commentType: CommentType.Text, isDeleted: false }] as any }),
            makeThread({ id: 3, status: CommentThreadStatus.Active, comments: [{ content: 'c', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false }] as any }),
        ];
        const provider = await createProviderWithThreads(threads);
        provider.setReviewMode(true);
        provider.setCommentFilter('all');
        provider.setAuthorFilter('Alice');
        const filtered = provider.filteredThreads;
        assert.strictEqual(filtered.length, 2);
        assert.ok(filtered.every(t => t.comments?.some(c => (c.author as any)?.displayName === 'Alice')));
        provider.dispose();
    });

    test('returns empty when author has no threads', async () => {
        const threads = [
            makeThread({ id: 1, status: CommentThreadStatus.Active, comments: [{ content: 'a', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false }] as any }),
        ];
        const provider = await createProviderWithThreads(threads);
        provider.setReviewMode(true);
        provider.setCommentFilter('all');
        provider.setAuthorFilter('NonExistent');
        assert.strictEqual(provider.filteredThreads.length, 0);
        provider.dispose();
    });

    test('compound filter: active status + author', async () => {
        const threads = [
            makeThread({ id: 1, status: CommentThreadStatus.Active, comments: [{ content: 'a', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false }] as any }),
            makeThread({ id: 2, status: CommentThreadStatus.Fixed, comments: [{ content: 'b', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false }] as any }),
            makeThread({ id: 3, status: CommentThreadStatus.Active, comments: [{ content: 'c', author: { displayName: 'Bob' }, commentType: CommentType.Text, isDeleted: false }] as any }),
            makeThread({ id: 4, status: CommentThreadStatus.Fixed, comments: [{ content: 'd', author: { displayName: 'Bob' }, commentType: CommentType.Text, isDeleted: false }] as any }),
        ];
        const provider = await createProviderWithThreads(threads);
        provider.setReviewMode(true);

        // active + Alice → only thread 1
        provider.setCommentFilter('active');
        provider.setAuthorFilter('Alice');
        assert.strictEqual(provider.filteredThreads.length, 1);
        assert.strictEqual(provider.filteredThreads[0].id, 1);

        // all + Alice → threads 1, 2
        provider.setCommentFilter('all');
        provider.setAuthorFilter('Alice');
        assert.strictEqual(provider.filteredThreads.length, 2);

        // active + Bob → only thread 3
        provider.setCommentFilter('active');
        provider.setAuthorFilter('Bob');
        assert.strictEqual(provider.filteredThreads.length, 1);
        assert.strictEqual(provider.filteredThreads[0].id, 3);

        // active + null → threads 1, 3 (both active, any author)
        provider.setAuthorFilter(null);
        assert.strictEqual(provider.filteredThreads.length, 2);

        provider.dispose();
    });

    test('author filter includes thread if any non-deleted user comment matches', async () => {
        // Thread has one deleted comment by Alice and one live comment by Alice
        const threads = [
            makeThread({
                id: 1, status: CommentThreadStatus.Active, comments: [
                    { content: 'deleted', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: true },
                    { content: 'live', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false },
                ] as any
            }),
            // Thread with only a deleted comment by Bob — only the system comment survives
            makeThread({
                id: 2, status: CommentThreadStatus.Active, comments: [
                    { content: 'deleted', author: { displayName: 'Bob' }, commentType: CommentType.Text, isDeleted: true },
                    { content: 'system', author: { displayName: 'Bob' }, commentType: CommentType.System, isDeleted: false },
                ] as any
            }),
        ];
        const provider = await createProviderWithThreads(threads);
        provider.setReviewMode(true);
        provider.setCommentFilter('all');

        provider.setAuthorFilter('Alice');
        assert.strictEqual(provider.filteredThreads.length, 1);
        assert.strictEqual(provider.filteredThreads[0].id, 1);

        // Bob's only non-deleted comment is a System comment → excluded by author filter
        provider.setAuthorFilter('Bob');
        assert.strictEqual(provider.filteredThreads.length, 0);

        provider.dispose();
    });

    test('filteredThreads returns empty when reviewMode is off even with author set', async () => {
        const threads = [
            makeThread({ id: 1, status: CommentThreadStatus.Active, comments: [{ content: 'a', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false }] as any }),
        ];
        const provider = await createProviderWithThreads(threads);
        provider.setAuthorFilter('Alice');
        // reviewMode is off by default
        assert.deepStrictEqual(provider.filteredThreads, []);
        provider.dispose();
    });

    test('multi-author thread is included if any matching author comment exists', async () => {
        const threads = [
            makeThread({
                id: 1, status: CommentThreadStatus.Active, comments: [
                    { content: 'alice says', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false },
                    { content: 'bob replies', author: { displayName: 'Bob' }, commentType: CommentType.Text, isDeleted: false },
                ] as any
            }),
        ];
        const provider = await createProviderWithThreads(threads);
        provider.setReviewMode(true);
        provider.setCommentFilter('all');

        provider.setAuthorFilter('Alice');
        assert.strictEqual(provider.filteredThreads.length, 1);

        provider.setAuthorFilter('Bob');
        assert.strictEqual(provider.filteredThreads.length, 1);

        provider.setAuthorFilter('Charlie');
        assert.strictEqual(provider.filteredThreads.length, 0);

        provider.dispose();
    });
});

suite('ActivePrTreeDataProvider — refreshThreadsOnly', () => {
    test('re-fetches threads without clearing file/commit caches', async () => {
        let threadFetchCount = 0;
        let iterationFetchCount = 0;
        const pr: GitPullRequest = {
            pullRequestId: 42,
            title: 'Test PR',
            createdBy: { displayName: 'Owner', id: 'owner-id' },
            sourceRefName: 'refs/heads/feature',
            targetRefName: 'refs/heads/main',
            status: 1,
        } as any;

        const provider = new ActivePrTreeDataProvider(
            createMockPrService({
                findPrForBranch: async () => pr,
                getPrIterations: async () => { iterationFetchCount++; return [{ id: 1 }] as any; },
                getPrIterationChanges: async () => ({ changeEntries: [] }),
                getPrCommits: async () => [],
                getPrThreads: async () => {
                    threadFetchCount++;
                    return [makeThread({ id: 1 })];
                },
            }),
            createMockGitApi('feature'),
            createMockLog(),
        );

        // Initial load
        await provider.detectActivePr();
        const roots = await provider.getChildren();
        const prRoot = roots.find(r => r instanceof ActivePrRootItem);
        if (prRoot) { await provider.getChildren(prRoot); }

        assert.strictEqual(threadFetchCount, 1);
        assert.strictEqual(iterationFetchCount, 1);

        // refreshThreadsOnly should re-fetch threads but NOT iterations/files/commits
        await provider.refreshThreadsOnly();

        assert.strictEqual(threadFetchCount, 2, 'threads should be re-fetched');
        assert.strictEqual(iterationFetchCount, 1, 'iterations should NOT be re-fetched');

        provider.dispose();
    });

    test('fires onDidChangeTreeData and onDidUpdateComments', async () => {
        let treeChanged = 0;
        let commentsUpdated = 0;

        const provider = await createProviderWithThreads([makeThread({ id: 1 })]);
        provider.onDidChangeTreeData(() => { treeChanged++; });
        provider.onDidUpdateComments(() => { commentsUpdated++; });

        await provider.refreshThreadsOnly();

        assert.ok(treeChanged >= 1, 'onDidChangeTreeData should fire');
        assert.ok(commentsUpdated >= 1, 'onDidUpdateComments should fire');

        provider.dispose();
    });

    test('is a no-op when no active PR', async () => {
        const provider = new ActivePrTreeDataProvider(
            createMockPrService(),
            createMockGitApi(),
            createMockLog(),
        );

        // Should not throw
        await provider.refreshThreadsOnly();

        provider.dispose();
    });
});

suite('ActivePrTreeDataProvider — Auth Error Recovery', () => {
    test('calls onAuthError when detectActivePr gets a TF400813 error', async () => {
        let authErrorCalled = false;
        const provider = new ActivePrTreeDataProvider(
            createMockPrService({
                findPrForBranch: async () => {
                    throw new Error('TF400813: The user is not authorized to access this resource.');
                },
            }),
            createMockGitApi('feature'),
            createMockLog(),
            () => { authErrorCalled = true; },
        );

        await provider.detectActivePr();
        assert.ok(authErrorCalled, 'onAuthError should be called for TF400813');
        provider.dispose();
    });

    test('does not call onAuthError for non-auth errors in detectActivePr', async () => {
        let authErrorCalled = false;
        const provider = new ActivePrTreeDataProvider(
            createMockPrService({
                findPrForBranch: async () => { throw new Error('Network timeout'); },
            }),
            createMockGitApi('feature'),
            createMockLog(),
            () => { authErrorCalled = true; },
        );

        await provider.detectActivePr();
        assert.ok(!authErrorCalled, 'onAuthError should not be called for non-auth errors');
        provider.dispose();
    });

    test('calls onAuthError when ensureData gets an auth error', async () => {
        let authErrorCalled = false;
        const pr: GitPullRequest = {
            pullRequestId: 42,
            title: 'Test PR',
            createdBy: { displayName: 'Owner' },
            sourceRefName: 'refs/heads/feature',
            targetRefName: 'refs/heads/main',
            status: 1,
        } as any;

        const provider = new ActivePrTreeDataProvider(
            createMockPrService({
                findPrForBranch: async () => pr,
                getPrIterations: async () => {
                    throw new Error('TF400813: The user is not authorized to access this resource.');
                },
            }),
            createMockGitApi('feature'),
            createMockLog(),
            () => { authErrorCalled = true; },
        );

        await provider.detectActivePr();
        // Trigger ensureData by expanding the tree
        const roots = await provider.getChildren();
        const prRoot = roots.find(r => r instanceof ActivePrRootItem);
        if (prRoot) { await provider.getChildren(prRoot); }

        assert.ok(authErrorCalled, 'onAuthError should be called for auth error in ensureData');
        provider.dispose();
    });
});
