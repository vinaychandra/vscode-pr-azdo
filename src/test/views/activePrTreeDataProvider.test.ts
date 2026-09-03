import * as assert from 'assert';
import * as vscode from 'vscode';
import { ActivePrTreeDataProvider, type CommentFilter } from '../../views/activePrTreeDataProvider';
import { ActivePrRootItem, ReviewModeToggleItem } from '../../views/activePrTreeItems';
import { CommentThreadStatus, CommentType, VersionControlChangeType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { GitPullRequestCommentThread, GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { PullRequestService } from '../../azdo/prService';
import type { API, Repository, RepositoryState } from '../../typings/git';
import { reviewedFilesStateKey } from '../../views/reviewState';

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
        findPrForCommit: async () => undefined,
        getPrIterations: async () => [],
        getPrIterationChanges: async () => ({ changeEntries: [] }),
        getPrCommits: async () => [],
        getPrThreads: async () => [],
        isConnected: true,
        ...overrides,
    } as unknown as PullRequestService;
}

function createMockGitApi(branchName?: string, commitId?: string): API {
    const state: RepositoryState = {
        HEAD: branchName || commitId ? { name: branchName, commit: commitId } : undefined,
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

suite('ActivePrTreeDataProvider — reviewed-file state', () => {
    test('uses a distinct persistence key for each pull request', () => {
        assert.notStrictEqual(reviewedFilesStateKey(41), reviewedFilesStateKey(42));
    });

    test('uses a distinct persistence key for the same PR ID in another repository', () => {
        assert.notStrictEqual(reviewedFilesStateKey(42), reviewedFilesStateKey('external:org/project/repo/42'));
    });

    test('clears reviewed files when the active pull request changes', async () => {
        let currentPr = { pullRequestId: 41, title: 'First PR' } as GitPullRequest;
        const provider = new ActivePrTreeDataProvider(
            createMockPrService({ findPrForBranch: async () => currentPr }),
            createMockGitApi('feature'),
            createMockLog(),
        );
        await provider.detectActivePr();
        provider.markFileReviewed('src/first.ts', true);
        assert.strictEqual(provider.reviewedFiles.has('src/first.ts'), true);

        currentPr = { pullRequestId: 42, title: 'Second PR' } as GitPullRequest;
        await provider.detectActivePr();

        assert.strictEqual(provider.reviewedFiles.size, 0);
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
    test('returns empty when no active PR and connected', async () => {
        const provider = new ActivePrTreeDataProvider(
            createMockPrService(),
            createMockGitApi(), // no branch → no PR
            createMockLog(),
        );
        const roots = await provider.getChildren();
        assert.strictEqual(roots.length, 0);
        provider.dispose();
    });

    test('returns sign-in item when not connected', async () => {
        const provider = new ActivePrTreeDataProvider(
            createMockPrService({ isConnected: false } as any),
            createMockGitApi(),
            createMockLog(),
        );
        const roots = await provider.getChildren();
        assert.strictEqual(roots.length, 1);
        const item = roots[0] as unknown as vscode.TreeItem;
        assert.strictEqual(item.label, 'Sign in to Azure DevOps');
        assert.strictEqual(item.command?.command, 'vscode-pr-azdo.signIn');
        provider.dispose();
    });
});

suite('ActivePrTreeDataProvider — detectActivePr when not connected', () => {
    test('skips detection when not connected', async () => {
        let findPrCalled = false;
        const provider = new ActivePrTreeDataProvider(
            createMockPrService({
                isConnected: false,
                findPrForBranch: async () => { findPrCalled = true; return undefined; },
            } as any),
            createMockGitApi('feature'),
            createMockLog(),
        );
        await provider.detectActivePr();
        assert.ok(!findPrCalled, 'findPrForBranch should not be called when disconnected');
        provider.dispose();
    });
});

suite('ActivePrTreeDataProvider — commit detection', () => {
    const testPr = {
        pullRequestId: 42,
        title: 'Commit PR',
        sourceRefName: 'refs/heads/feature',
        targetRefName: 'refs/heads/main',
    } as GitPullRequest;

    test('falls back to the current commit when no branch PR is found', async () => {
        let receivedCommit: string | undefined;
        const provider = new ActivePrTreeDataProvider(
            createMockPrService({
                findPrForBranch: async () => undefined,
                findPrForCommit: async commitId => {
                    receivedCommit = commitId;
                    return testPr;
                },
            }),
            createMockGitApi('feature', 'abc123'),
            createMockLog(),
        );

        await provider.detectActivePr();

        assert.strictEqual(receivedCommit, 'abc123');
        const roots = await provider.getChildren();
        assert.ok(roots.some(root => root instanceof ActivePrRootItem));
        provider.dispose();
    });

    test('detects an active PR from a detached HEAD commit', async () => {
        let branchLookupCalled = false;
        const provider = new ActivePrTreeDataProvider(
            createMockPrService({
                findPrForBranch: async () => {
                    branchLookupCalled = true;
                    return undefined;
                },
                findPrForCommit: async commitId => commitId === 'abc123' ? testPr : undefined,
            }),
            createMockGitApi(undefined, 'abc123'),
            createMockLog(),
        );

        await provider.detectActivePr();

        assert.strictEqual(branchLookupCalled, false);
        const roots = await provider.getChildren();
        assert.ok(roots.some(root => root instanceof ActivePrRootItem));
        provider.dispose();
    });

    test('does not query by commit when branch lookup succeeds', async () => {
        let commitLookupCalled = false;
        const provider = new ActivePrTreeDataProvider(
            createMockPrService({
                findPrForBranch: async () => testPr,
                findPrForCommit: async () => {
                    commitLookupCalled = true;
                    return undefined;
                },
            }),
            createMockGitApi('feature', 'abc123'),
            createMockLog(),
        );

        await provider.detectActivePr();

        assert.strictEqual(commitLookupCalled, false);
        provider.dispose();
    });
});

suite('ActivePrTreeDataProvider — auth lifecycle', () => {
    const testPr: GitPullRequest = {
        pullRequestId: 42,
        title: 'Test PR',
        createdBy: { displayName: 'Owner', id: 'owner-id' },
        sourceRefName: 'refs/heads/feature',
        targetRefName: 'refs/heads/main',
        status: 1, // Active
    } as any;

    function createMutableService(connected: boolean) {
        const svc = {
            findPrForBranch: async () => testPr,
            getPrIterations: async () => [{ id: 1 }],
            getPrIterationChanges: async () => ({ changeEntries: [] }),
            getPrCommits: async () => [],
            getPrThreads: async () => [],
            isConnected: connected,
        };
        return svc as unknown as PullRequestService;
    }

    test('sign-in item → connect → PR tree → expire → sign-in item again', async () => {
        const svc = createMutableService(false);
        const provider = new ActivePrTreeDataProvider(
            svc,
            createMockGitApi('feature'),
            createMockLog(),
        );

        // 1. Initially not connected — sign-in item shown, detectActivePr skipped
        let findCalled = false;
        (svc as any).findPrForBranch = async () => { findCalled = true; return testPr; };
        await provider.detectActivePr();
        assert.ok(!findCalled, 'findPrForBranch should not be called when disconnected');

        let roots = await provider.getChildren();
        assert.strictEqual(roots.length, 1);
        const signInItem = roots[0] as unknown as vscode.TreeItem;
        assert.strictEqual(signInItem.label, 'Sign in to Azure DevOps');
        assert.strictEqual(signInItem.command?.command, 'vscode-pr-azdo.signIn');

        // 2. User signs in — simulate silent auth succeeded
        (svc as any).isConnected = true;
        findCalled = false;
        await provider.detectActivePr();
        assert.ok(findCalled, 'findPrForBranch should be called once connected');

        roots = await provider.getChildren();
        assert.strictEqual(roots.length, 2); // ReviewModeToggleItem + ActivePrRootItem
        assert.ok(roots[1] instanceof ActivePrRootItem);

        // 3. Token expires — simulate disconnect
        (svc as any).isConnected = false;

        // Branch change triggers detectActivePr — should be silently skipped
        findCalled = false;
        await provider.detectActivePr();
        assert.ok(!findCalled, 'findPrForBranch should not be called after token expiry');

        // After detectActivePr sets activePr to undefined, tree should show sign-in
        roots = await provider.getChildren();
        assert.strictEqual(roots.length, 1);
        const reSignIn = roots[0] as unknown as vscode.TreeItem;
        assert.strictEqual(reSignIn.label, 'Sign in to Azure DevOps');

        // 4. User clicks sign-in again
        (svc as any).isConnected = true;
        await provider.detectActivePr();
        roots = await provider.getChildren();
        assert.strictEqual(roots.length, 2);
        assert.ok(roots[1] instanceof ActivePrRootItem);

        provider.dispose();
    });

    test('silent re-auth succeeds — no sign-in item shown', async () => {
        // Start connected with a PR
        const svc = createMutableService(true);
        const provider = new ActivePrTreeDataProvider(
            svc,
            createMockGitApi('feature'),
            createMockLog(),
        );
        await provider.detectActivePr();
        let roots = await provider.getChildren();
        assert.strictEqual(roots.length, 2);

        // Simulate: token expired but silent re-auth succeeded (isConnected stays true)
        // In the real flow, handleAuthError calls tryConnectSilently which succeeds,
        // so isConnected remains true and proxy emitters re-fire.
        provider.refresh();
        await provider.detectActivePr();
        roots = await provider.getChildren();
        assert.strictEqual(roots.length, 2, 'Should still show PR tree after silent re-auth');
        assert.ok(roots[1] instanceof ActivePrRootItem);

        provider.dispose();
    });

    test('silent re-auth fails — sign-in item replaces PR tree', async () => {
        // Start connected with a PR
        const svc = createMutableService(true);
        const provider = new ActivePrTreeDataProvider(
            svc,
            createMockGitApi('feature'),
            createMockLog(),
        );
        await provider.detectActivePr();
        let roots = await provider.getChildren();
        assert.strictEqual(roots.length, 2);
        assert.ok(roots[1] instanceof ActivePrRootItem);

        // Simulate: token expired and silent re-auth also failed
        // handleAuthError would call resetConnection → isConnected = false,
        // then fire proxy emitters → getChildren re-queries
        (svc as any).isConnected = false;
        provider.refresh();
        await provider.detectActivePr();

        roots = await provider.getChildren();
        assert.strictEqual(roots.length, 1);
        const item = roots[0] as unknown as vscode.TreeItem;
        assert.strictEqual(item.label, 'Sign in to Azure DevOps');
        assert.strictEqual(item.command?.command, 'vscode-pr-azdo.signIn');

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

// --- getChangeType tests ---

/** Create a provider with an active PR and file changes that populate _changeTypeMap. */
async function createProviderWithChanges(
    changes: { path: string; changeType: VersionControlChangeType }[],
): Promise<ActivePrTreeDataProvider> {
    const pr: GitPullRequest = {
        pullRequestId: 99,
        title: 'Change Type Test PR',
        createdBy: { displayName: 'Owner', id: 'owner-id' },
        sourceRefName: 'refs/heads/feature',
        targetRefName: 'refs/heads/main',
        status: 1,
    } as any;

    const changeEntries = changes.map(c => ({
        item: { path: '/' + c.path },
        changeType: c.changeType,
    }));

    const provider = new ActivePrTreeDataProvider(
        createMockPrService({
            findPrForBranch: async () => pr,
            getPrIterations: async () => [{ id: 1 }] as any,
            getPrIterationChanges: async () => ({ changeEntries }),
            getPrCommits: async () => [],
            getPrThreads: async () => [],
        }),
        createMockGitApi('feature'),
        createMockLog(),
    );

    await provider.detectActivePr();
    const roots = await provider.getChildren();
    const prRoot = roots.find(r => r instanceof ActivePrRootItem);
    if (prRoot) {
        await provider.getChildren(prRoot);
    }

    return provider;
}

suite('ActivePrTreeDataProvider — getChangeType', () => {
    test('returns undefined when no data loaded', () => {
        const provider = new ActivePrTreeDataProvider(
            createMockPrService(),
            createMockGitApi(),
            createMockLog(),
        );
        assert.strictEqual(provider.getChangeType('src/index.ts'), undefined);
        provider.dispose();
    });

    test('returns correct change type for edited file', async () => {
        const provider = await createProviderWithChanges([
            { path: 'src/index.ts', changeType: VersionControlChangeType.Edit },
        ]);
        assert.strictEqual(provider.getChangeType('src/index.ts'), VersionControlChangeType.Edit);
        provider.dispose();
    });

    test('returns correct change type for added file', async () => {
        const provider = await createProviderWithChanges([
            { path: 'src/new.ts', changeType: VersionControlChangeType.Add },
        ]);
        assert.strictEqual(provider.getChangeType('src/new.ts'), VersionControlChangeType.Add);
        provider.dispose();
    });

    test('returns correct change type for deleted file', async () => {
        const provider = await createProviderWithChanges([
            { path: 'src/old.ts', changeType: VersionControlChangeType.Delete },
        ]);
        assert.strictEqual(provider.getChangeType('src/old.ts'), VersionControlChangeType.Delete);
        provider.dispose();
    });

    test('returns undefined for unknown file path', async () => {
        const provider = await createProviderWithChanges([
            { path: 'src/index.ts', changeType: VersionControlChangeType.Edit },
        ]);
        assert.strictEqual(provider.getChangeType('src/other.ts'), undefined);
        provider.dispose();
    });

    test('tracks multiple files with different change types', async () => {
        const provider = await createProviderWithChanges([
            { path: 'src/index.ts', changeType: VersionControlChangeType.Edit },
            { path: 'src/new.ts', changeType: VersionControlChangeType.Add },
            { path: 'src/old.ts', changeType: VersionControlChangeType.Delete },
            { path: 'README.md', changeType: VersionControlChangeType.Edit },
        ]);
        assert.strictEqual(provider.getChangeType('src/index.ts'), VersionControlChangeType.Edit);
        assert.strictEqual(provider.getChangeType('src/new.ts'), VersionControlChangeType.Add);
        assert.strictEqual(provider.getChangeType('src/old.ts'), VersionControlChangeType.Delete);
        assert.strictEqual(provider.getChangeType('README.md'), VersionControlChangeType.Edit);
        assert.strictEqual(provider.getChangeType('nonexistent.ts'), undefined);
        provider.dispose();
    });

    test('strips leading slash from AzDO paths', async () => {
        // AzDO returns paths like /src/index.ts — the map should store them without leading /
        const provider = await createProviderWithChanges([
            { path: 'src/index.ts', changeType: VersionControlChangeType.Edit },
        ]);
        // The path stored should be without leading /
        assert.strictEqual(provider.getChangeType('src/index.ts'), VersionControlChangeType.Edit);
        // With leading / should not match
        assert.strictEqual(provider.getChangeType('/src/index.ts'), undefined);
        provider.dispose();
    });

    test('changedFilePaths and getChangeType are consistent', async () => {
        const provider = await createProviderWithChanges([
            { path: 'src/a.ts', changeType: VersionControlChangeType.Edit },
            { path: 'src/b.ts', changeType: VersionControlChangeType.Add },
        ]);
        const paths = provider.changedFilePaths;
        for (const p of paths) {
            assert.notStrictEqual(provider.getChangeType(p), undefined, `getChangeType should return a value for ${p}`);
        }
        provider.dispose();
    });

    test('refresh clears changeTypeMap', async () => {
        const provider = await createProviderWithChanges([
            { path: 'src/index.ts', changeType: VersionControlChangeType.Edit },
        ]);
        assert.strictEqual(provider.getChangeType('src/index.ts'), VersionControlChangeType.Edit);
        // After refresh, the map is cleared (provider re-detects PR, but with no active branch the map stays empty)
        provider.refresh();
        assert.strictEqual(provider.getChangeType('src/index.ts'), undefined);
        provider.dispose();
    });
});

// --- Real-shape AzDO delete entry ---
// Deletes return a different payload shape than edits/adds:
//   { originalPath: '/File2', item: { path: null, originalObjectId: '...' }, changeType: 16 }
// The provider must read originalPath when item.path is null.
suite('ActivePrTreeDataProvider — delete entry shape', () => {
    test('populates changeTypeMap and tree from AzDO delete payload', async () => {
        const pr: GitPullRequest = {
            pullRequestId: 4,
            title: 'Deleted File2',
            createdBy: { displayName: 'Owner', id: 'owner-id' },
            sourceRefName: 'refs/heads/deletef2',
            targetRefName: 'refs/heads/main',
            status: 1,
        } as any;

        // Exact payload observed from AzDO for a Delete entry
        const deleteEntry = {
            changeTrackingId: 1,
            originalPath: '/File2',
            changeId: 1,
            item: { originalObjectId: 'B4F8B3659348CE7EE18871B9C25AC0889A9E974C', path: null },
            changeType: VersionControlChangeType.Delete,
        } as any;

        const provider = new ActivePrTreeDataProvider(
            createMockPrService({
                findPrForBranch: async () => pr,
                getPrIterations: async () => [{ id: 1 }] as any,
                getPrIterationChanges: async () => ({ changeEntries: [deleteEntry] }),
                getPrCommits: async () => [],
                getPrThreads: async () => [],
            }),
            createMockGitApi('deletef2'),
            createMockLog(),
        );

        await provider.detectActivePr();
        const roots = await provider.getChildren();
        const prRoot = roots.find(r => r instanceof ActivePrRootItem);
        if (prRoot) {
            await provider.getChildren(prRoot);
        }

        assert.strictEqual(provider.getChangeType('File2'), VersionControlChangeType.Delete);
        assert.deepStrictEqual(provider.changedFilePaths, ['File2']);
        provider.dispose();
    });
});

// --- Ref-change gating ---
// VS Code's git extension fires repo.state.onDidChange every ~10–15s (polling)
// and on any working-tree / index change. We must only re-run detection when
// the branch name or commit actually changed.
suite('ActivePrTreeDataProvider — branch-change gating', () => {
    /**
     * Build a repo+gitApi pair with a mutable HEAD and a manually fireable
     * onDidChange event, so tests can simulate the VS Code git extension
     * notifying about repo state changes.
     */
    function makeMutableGitApi(initialBranch?: string, initialCommit?: string) {
        const stateEmitter = new vscode.EventEmitter<void>();
        const head: { name: string | undefined; commit: string | undefined } = {
            name: initialBranch,
            commit: initialCommit,
        };
        const state = {
            HEAD: head,
            onDidChange: stateEmitter.event,
        } as any;
        const repo = { state } as any;
        const api = {
            repositories: [repo],
            onDidOpenRepository: new vscode.EventEmitter<any>().event,
        } as unknown as API;
        return {
            api,
            setBranch(name: string | undefined) { head.name = name; },
            setCommit(commit: string | undefined) { head.commit = commit; },
            fireStateChange() { stateEmitter.fire(); },
            dispose() { stateEmitter.dispose(); },
        };
    }

    test('skips findPrForBranch when state-change event fires with same branch', async () => {
        let findCalls = 0;
        const harness = makeMutableGitApi('feature/abc');
        const provider = new ActivePrTreeDataProvider(
            createMockPrService({
                findPrForBranch: async () => {
                    findCalls++;
                    return undefined;
                },
            }),
            harness.api,
            createMockLog(),
        );

        // Wait for initial detectActivePr (kicked off in the constructor).
        await new Promise(r => setTimeout(r, 0));
        const callsAfterInit = findCalls;
        assert.ok(callsAfterInit >= 1, 'initial detection should call findPrForBranch');

        // Fire several state-change events without changing the branch.
        harness.fireStateChange();
        harness.fireStateChange();
        harness.fireStateChange();
        await new Promise(r => setTimeout(r, 0));

        assert.strictEqual(findCalls, callsAfterInit, 'findPrForBranch should NOT be re-called when branch is unchanged');

        provider.dispose();
        harness.dispose();
    });

    test('calls findPrForBranch again when the branch actually changes', async () => {
        let findCalls = 0;
        const harness = makeMutableGitApi('feature/abc');
        const provider = new ActivePrTreeDataProvider(
            createMockPrService({
                findPrForBranch: async () => {
                    findCalls++;
                    return undefined;
                },
            }),
            harness.api,
            createMockLog(),
        );

        await new Promise(r => setTimeout(r, 0));
        const callsAfterInit = findCalls;

        // Branch changed → detection must re-run.
        harness.setBranch('feature/xyz');
        harness.fireStateChange();
        await new Promise(r => setTimeout(r, 0));
        assert.strictEqual(findCalls, callsAfterInit + 1, 'findPrForBranch should be re-called when branch changes');

        // Same new branch fires another state change → no extra call.
        harness.fireStateChange();
        await new Promise(r => setTimeout(r, 0));
        assert.strictEqual(findCalls, callsAfterInit + 1, 'findPrForBranch should not be called again on a no-op state change');

        provider.dispose();
        harness.dispose();
    });

    test('pins a snapshot review across local branch changes', async () => {
        let findCalls = 0;
        const harness = makeMutableGitApi('local/main', 'local-commit');
        const provider = new ActivePrTreeDataProvider(
            createMockPrService({
                findPrForBranch: async () => {
                    findCalls++;
                    return undefined;
                },
            }),
            harness.api,
            createMockLog(),
        );
        await new Promise(resolve => setTimeout(resolve, 0));

        const snapshotPr = { pullRequestId: 42, title: 'Snapshot review' } as GitPullRequest;
        provider.pinSnapshotReview(snapshotPr, 'source-sha', 'target-sha');
        const callsBeforeBranchChange = findCalls;
        harness.setBranch('local/other');
        harness.setCommit('other-commit');
        harness.fireStateChange();
        await new Promise(resolve => setTimeout(resolve, 0));

        assert.strictEqual(provider._activePrForContext?.pullRequestId, 42);
        assert.strictEqual(provider.reviewContext?.mode, 'snapshot');
        assert.strictEqual(provider.reviewContext?.sourceRef, 'source-sha');
        assert.strictEqual(provider.reviewContext?.targetRef, 'target-sha');
        assert.strictEqual(findCalls, callsBeforeBranchChange);

        provider.dispose();
        harness.dispose();
    });

    test('uses a snapshot repository service until the review stops', async () => {
        let workspaceIterationCalls = 0;
        let snapshotIterationCalls = 0;
        const workspaceService = createMockPrService({
            getPrIterations: async () => {
                workspaceIterationCalls++;
                return [];
            },
        });
        const snapshotService = createMockPrService({
            getPrIterations: async () => {
                snapshotIterationCalls++;
                return [];
            },
        });
        const harness = makeMutableGitApi('local/main', 'local-commit');
        const provider = new ActivePrTreeDataProvider(workspaceService, harness.api, createMockLog());
        await new Promise(resolve => setTimeout(resolve, 0));

        const snapshotPr = { pullRequestId: 42, title: 'External snapshot' } as GitPullRequest;
        provider.pinSnapshotReview(snapshotPr, 'source-sha', 'target-sha', snapshotService);
        const root = (await provider.getChildren())[1] as ActivePrRootItem;
        await provider.getChildren(root);

        assert.strictEqual(snapshotIterationCalls, 1);
        assert.strictEqual(workspaceIterationCalls, 0);

        provider.stopSnapshotReview(workspaceService);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.strictEqual(provider.isSnapshotReview, false);

        provider.dispose();
        harness.dispose();
    });

    test('ignores an older branch lookup that resolves after a newer one', async () => {
        const firstPr = { pullRequestId: 1, title: 'First branch' } as GitPullRequest;
        const secondPr = { pullRequestId: 2, title: 'Second branch' } as GitPullRequest;
        let resolveFirst!: (pr: GitPullRequest) => void;
        const firstLookup = new Promise<GitPullRequest>(resolve => {
            resolveFirst = resolve;
        });
        const harness = makeMutableGitApi('feature/first');
        const provider = new ActivePrTreeDataProvider(
            createMockPrService({
                findPrForBranch: branchName => branchName === 'feature/first'
                    ? firstLookup
                    : Promise.resolve(secondPr),
            }),
            harness.api,
            createMockLog(),
        );

        await new Promise(resolve => setTimeout(resolve, 0));
        harness.setBranch('feature/second');
        await provider.detectActivePr();
        assert.strictEqual(provider._activePrForContext?.pullRequestId, 2);

        resolveFirst(firstPr);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.strictEqual(provider._activePrForContext?.pullRequestId, 2);

        provider.dispose();
        harness.dispose();
    });

    test('ignores data loaded for a PR that is no longer active', async () => {
        const firstPr = { pullRequestId: 1, title: 'First branch' } as GitPullRequest;
        const secondPr = { pullRequestId: 2, title: 'Second branch' } as GitPullRequest;
        let resolveFirstIterations!: (iterations: { id: number }[]) => void;
        const firstIterations = new Promise<{ id: number }[]>(resolve => {
            resolveFirstIterations = resolve;
        });
        const harness = makeMutableGitApi('feature/first');
        const provider = new ActivePrTreeDataProvider(
            createMockPrService({
                findPrForBranch: async branchName => branchName === 'feature/first' ? firstPr : secondPr,
                getPrIterations: async prId => prId === 1 ? firstIterations as any : [],
                getPrIterationChanges: async () => ({
                    changeEntries: [{ item: { path: '/stale.ts' }, changeType: VersionControlChangeType.Edit } as any],
                }),
            }),
            harness.api,
            createMockLog(),
        );

        await provider.detectActivePr();
        const firstRoot = (await provider.getChildren()).find(item => item instanceof ActivePrRootItem);
        assert.ok(firstRoot);
        const staleLoad = provider.getChildren(firstRoot);

        harness.setBranch('feature/second');
        await provider.detectActivePr();
        resolveFirstIterations([{ id: 1 }]);
        await staleLoad;

        assert.strictEqual(provider._activePrForContext?.pullRequestId, 2);
        assert.deepStrictEqual(provider.changedFilePaths, []);

        provider.dispose();
        harness.dispose();
    });

    test('re-detects when the commit changes on the same branch', async () => {
        let commitLookups = 0;
        const harness = makeMutableGitApi('feature/abc', 'commit-1');
        const provider = new ActivePrTreeDataProvider(
            createMockPrService({
                findPrForBranch: async () => undefined,
                findPrForCommit: async () => {
                    commitLookups++;
                    return undefined;
                },
            }),
            harness.api,
            createMockLog(),
        );

        await new Promise(resolve => setTimeout(resolve, 0));
        const callsAfterInit = commitLookups;

        harness.setCommit('commit-2');
        harness.fireStateChange();
        await new Promise(resolve => setTimeout(resolve, 0));

        assert.strictEqual(commitLookups, callsAfterInit + 1);
        provider.dispose();
        harness.dispose();
    });

    test('refresh() resets gating so the next state-change re-detects even on same branch', async () => {
        let findCalls = 0;
        const harness = makeMutableGitApi('feature/abc');
        const provider = new ActivePrTreeDataProvider(
            createMockPrService({
                findPrForBranch: async () => {
                    findCalls++;
                    return undefined;
                },
            }),
            harness.api,
            createMockLog(),
        );

        await new Promise(r => setTimeout(r, 0));

        // Idle state change — gated.
        harness.fireStateChange();
        await new Promise(r => setTimeout(r, 0));
        const beforeRefresh = findCalls;

        provider.refresh();
        await new Promise(r => setTimeout(r, 0));
        assert.strictEqual(findCalls, beforeRefresh + 1, 'refresh() should force a re-detection');

        provider.dispose();
        harness.dispose();
    });
});
