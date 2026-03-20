import * as assert from 'assert';
import * as vscode from 'vscode';
import type { GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { PullRequestService } from '../../azdo/prService';
import type { AzDoApiClient } from '../../azdo/apiClient';
import { PrTreeDataProvider } from '../../views/prTreeDataProvider';
import { CategoryTreeItem, PullRequestTreeItem, VoteFilterItem } from '../../views/prTreeItems';

function makePr(id: number, title: string, isDraft = false): GitPullRequest {
    return {
        pullRequestId: id,
        title,
        sourceRefName: 'refs/heads/feature',
        targetRefName: 'refs/heads/main',
        isDraft,
        createdBy: { displayName: 'Tester', ...({} as any) },
    };
}

function createMockPrService(open: GitPullRequest[], mine: GitPullRequest[], review: GitPullRequest[]): PullRequestService {
    return {
        getOpenPullRequests: async () => open,
        getMyPullRequests: async () => mine,
        getPullRequestsAwaitingMyReview: async () => review,
    } as unknown as PullRequestService;
}

function createMockApiClient(): AzDoApiClient {
    return {
        getCurrentUserId: async () => 'user-123',
    } as unknown as AzDoApiClient;
}

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

suite('PrTreeDataProvider', () => {
    const pr1 = makePr(1, 'PR One');
    const pr2 = makePr(2, 'PR Two');
    const pr3 = makePr(3, 'PR Three', true);

    test('root returns three category nodes', async () => {
        const provider = new PrTreeDataProvider(
            createMockPrService([], [], []),
            createMockApiClient(),
            createMockLog(),
        );
        const roots = await provider.getChildren();
        assert.strictEqual(roots.length, 3);
        assert.ok(roots[0] instanceof CategoryTreeItem);
        assert.ok(roots[1] instanceof CategoryTreeItem);
        assert.ok(roots[2] instanceof CategoryTreeItem);
        assert.strictEqual((roots[0] as CategoryTreeItem).category, 'allOpen');
        assert.strictEqual((roots[1] as CategoryTreeItem).category, 'createdByMe');
        assert.strictEqual((roots[2] as CategoryTreeItem).category, 'waitingForReview');
        provider.dispose();
    });

    test('expanding "allOpen" returns PR items', async () => {
        const provider = new PrTreeDataProvider(
            createMockPrService([pr1, pr2], [], []),
            createMockApiClient(),
            createMockLog(),
        );
        const category = new CategoryTreeItem('allOpen', 'All Open', undefined);
        const children = await provider.getChildren(category);
        assert.strictEqual(children.length, 2);
        assert.ok(children[0] instanceof PullRequestTreeItem);
        assert.strictEqual((children[0] as PullRequestTreeItem).pr.pullRequestId, 1);
        assert.strictEqual((children[1] as PullRequestTreeItem).pr.pullRequestId, 2);
        provider.dispose();
    });

    test('expanding "createdByMe" returns PR items', async () => {
        const provider = new PrTreeDataProvider(
            createMockPrService([], [pr3], []),
            createMockApiClient(),
            createMockLog(),
        );
        const category = new CategoryTreeItem('createdByMe', 'Created By Me', undefined);
        const children = await provider.getChildren(category);
        assert.strictEqual(children.length, 1);
        assert.strictEqual((children[0] as PullRequestTreeItem).pr.title, 'PR Three');
        provider.dispose();
    });

    test('expanding "waitingForReview" returns vote filter groups', async () => {
        const prWithVote = {
            ...pr1,
            reviewers: [{ id: 'user-123', vote: 0 }],
        };
        const provider = new PrTreeDataProvider(
            createMockPrService([], [], [prWithVote]),
            createMockApiClient(),
            createMockLog(),
        );
        const category = new CategoryTreeItem('waitingForReview', 'Waiting for My Review', undefined);
        const children = await provider.getChildren(category);
        assert.strictEqual(children.length, 1);
        assert.ok(children[0] instanceof VoteFilterItem);
        assert.strictEqual((children[0] as VoteFilterItem).vote, 0);
        assert.strictEqual((children[0] as VoteFilterItem).prs.length, 1);
        provider.dispose();
    });

    test('getChildren returns empty for leaf nodes', async () => {
        const provider = new PrTreeDataProvider(
            createMockPrService([], [], []),
            createMockApiClient(),
            createMockLog(),
        );
        const prItem = new PullRequestTreeItem(pr1);
        const children = await provider.getChildren(prItem);
        assert.strictEqual(children.length, 0);
        provider.dispose();
    });

    test('caches results after first fetch', async () => {
        let callCount = 0;
        const mockService = {
            getOpenPullRequests: async () => { callCount++; return [pr1]; },
            getMyPullRequests: async () => [],
            getPullRequestsAwaitingMyReview: async () => [],
        } as unknown as PullRequestService;

        const provider = new PrTreeDataProvider(
            mockService,
            createMockApiClient(),
            createMockLog(),
        );
        const category = new CategoryTreeItem('allOpen', 'All Open', undefined);

        await provider.getChildren(category);
        assert.strictEqual(callCount, 1);

        await provider.getChildren(category);
        assert.strictEqual(callCount, 1); // cached — should not call again

        provider.dispose();
    });

    test('refresh clears cache and fires event', async () => {
        let callCount = 0;
        const mockService = {
            getOpenPullRequests: async () => { callCount++; return [pr1]; },
            getMyPullRequests: async () => [],
            getPullRequestsAwaitingMyReview: async () => [],
        } as unknown as PullRequestService;

        const provider = new PrTreeDataProvider(
            mockService,
            createMockApiClient(),
            createMockLog(),
        );
        const category = new CategoryTreeItem('allOpen', 'All Open', undefined);

        await provider.getChildren(category);
        assert.strictEqual(callCount, 1);

        let eventFired = false;
        provider.onDidChangeTreeData(() => { eventFired = true; });
        provider.refresh();

        assert.ok(eventFired);

        await provider.getChildren(category);
        assert.strictEqual(callCount, 2); // cache cleared — should call again

        provider.dispose();
    });

    test('handles service errors gracefully', async () => {
        const mockService = {
            getOpenPullRequests: async () => { throw new Error('Network error'); },
            getMyPullRequests: async () => [],
            getPullRequestsAwaitingMyReview: async () => [],
        } as unknown as PullRequestService;

        const provider = new PrTreeDataProvider(
            mockService,
            createMockApiClient(),
            createMockLog(),
        );
        const category = new CategoryTreeItem('allOpen', 'All Open', undefined);
        const children = await provider.getChildren(category);
        assert.strictEqual(children.length, 0); // should not throw
        provider.dispose();
    });
});
