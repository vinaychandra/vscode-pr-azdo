import * as assert from 'assert';
import * as vscode from 'vscode';
import { ActivePrTreeDataProvider, type CommentFilter } from '../../views/activePrTreeDataProvider';
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
