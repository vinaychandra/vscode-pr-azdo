import * as assert from 'assert';
import * as vscode from 'vscode';
import { CategoryTreeItem, PullRequestTreeItem, VoteFilterItem, groupPrsByVote } from '../../views/prTreeItems';
import type { GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';

suite('CategoryTreeItem', () => {
    test('sets label and collapsible state', () => {
        const item = new CategoryTreeItem('allOpen', 'All Open', undefined);
        assert.strictEqual(item.label, 'All Open');
        assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
        assert.strictEqual(item.contextValue, 'prCategory');
    });

    test('shows count in description when provided', () => {
        const item = new CategoryTreeItem('allOpen', 'All Open', 5);
        assert.strictEqual(item.description, '5');
    });

    test('empty description when count is undefined', () => {
        const item = new CategoryTreeItem('createdByMe', 'Created By Me', undefined);
        assert.strictEqual(item.description, '');
    });

    test('stores category type', () => {
        const item = new CategoryTreeItem('waitingForReview', 'Waiting for My Review', 3);
        assert.strictEqual(item.category, 'waitingForReview');
    });
});

suite('PullRequestTreeItem', () => {
    function makePr(overrides: Partial<GitPullRequest> = {}): GitPullRequest {
        return {
            pullRequestId: 42,
            title: 'Fix the thing',
            sourceRefName: 'refs/heads/feature/fix',
            targetRefName: 'refs/heads/main',
            isDraft: false,
            createdBy: { displayName: 'Alice', ...({} as any) },
            ...overrides,
        };
    }

    test('sets label to PR title', () => {
        const item = new PullRequestTreeItem(makePr());
        assert.strictEqual(item.label, 'Fix the thing');
    });

    test('uses (untitled) for missing title', () => {
        const item = new PullRequestTreeItem(makePr({ title: undefined }));
        assert.strictEqual(item.label, '(untitled)');
    });

    test('description shows PR number and short author name', () => {
        const item = new PullRequestTreeItem(makePr());
        assert.strictEqual(item.description, '#42 · Alice');
    });

    test('non-collapsible leaf node', () => {
        const item = new PullRequestTreeItem(makePr());
        assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
    });

    test('uses git-pull-request icon for non-draft PRs', () => {
        const item = new PullRequestTreeItem(makePr({ isDraft: false }));
        assert.ok(item.iconPath instanceof vscode.ThemeIcon);
        assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'git-pull-request');
    });

    test('uses git-pull-request-draft icon for draft PRs', () => {
        const item = new PullRequestTreeItem(makePr({ isDraft: true }));
        assert.ok(item.iconPath instanceof vscode.ThemeIcon);
        assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'git-pull-request-draft');
    });

    test('contextValue is pullRequest', () => {
        const item = new PullRequestTreeItem(makePr());
        assert.strictEqual(item.contextValue, 'pullRequest');
    });

    test('command opens the PR', () => {
        const pr = makePr();
        const item = new PullRequestTreeItem(pr);
        assert.ok(item.command);
        assert.strictEqual(item.command.command, 'vscode-pr-azdo.openPullRequest');
        assert.deepStrictEqual(item.command.arguments, [pr]);
    });

    test('stores reference to original PR object', () => {
        const pr = makePr();
        const item = new PullRequestTreeItem(pr);
        assert.strictEqual(item.pr, pr);
    });

    test('tooltip contains author name and branch info', () => {
        const item = new PullRequestTreeItem(makePr());
        assert.ok(item.tooltip instanceof vscode.MarkdownString);
        const md = (item.tooltip as vscode.MarkdownString).value;
        assert.ok(md.includes('Alice'));
        assert.ok(md.includes('feature/fix'));
        assert.ok(md.includes('main'));
    });

    test('description includes short author name (first name)', () => {
        const item = new PullRequestTreeItem(makePr({
            createdBy: { displayName: 'John Smith', ...({} as any) },
        }));
        assert.strictEqual(item.description, '#42 · John');
    });

    test('description uses full name when no space in display name', () => {
        const item = new PullRequestTreeItem(makePr({
            createdBy: { displayName: 'Alice', ...({} as any) },
        }));
        assert.strictEqual(item.description, '#42 · Alice');
    });

    test('description handles missing createdBy', () => {
        const item = new PullRequestTreeItem(makePr({
            createdBy: undefined,
        }));
        // Should not throw and should have some description
        assert.ok(typeof item.description === 'string');
    });

    test('tooltip strips refs/heads/ from branch names', () => {
        const item = new PullRequestTreeItem(makePr());
        assert.ok(item.tooltip instanceof vscode.MarkdownString);
        const md = (item.tooltip as vscode.MarkdownString).value;
        assert.ok(!md.includes('refs/heads/'));
    });
});

suite('VoteFilterItem', () => {
    function makePr(id: number): GitPullRequest {
        return { pullRequestId: id, title: `PR ${id}` } as any;
    }

    test('sets label and count', () => {
        const item = new VoteFilterItem(0, [makePr(1), makePr(2)]);
        assert.strictEqual(item.label, 'No vote yet');
        assert.strictEqual(item.description, '2');
    });

    test('is collapsible', () => {
        const item = new VoteFilterItem(10, [makePr(1)]);
        assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    });

    test('stores PRs', () => {
        const prs = [makePr(1), makePr(2)];
        const item = new VoteFilterItem(-5, prs);
        assert.strictEqual(item.prs, prs);
    });

    test('contextValue is voteFilter', () => {
        const item = new VoteFilterItem(0, []);
        assert.strictEqual(item.contextValue, 'voteFilter');
    });

    test('uses check icon for approved', () => {
        const item = new VoteFilterItem(10, [makePr(1)]);
        assert.ok(item.iconPath instanceof vscode.ThemeIcon);
        assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'check');
    });
});

suite('groupPrsByVote', () => {
    function makePr(id: number, vote: number, reviewerId = 'user-1'): GitPullRequest {
        return {
            pullRequestId: id,
            title: `PR ${id}`,
            reviewers: [{ id: reviewerId, vote }],
        } as any;
    }

    test('groups PRs by vote with correct order', () => {
        const prs = [
            makePr(1, 0),
            makePr(2, 10),
            makePr(3, -5),
            makePr(4, 0),
        ];
        const groups = groupPrsByVote(prs, 'user-1');
        const votes = groups.map(g => g.vote);
        // Order: 0, -5, 10 (only groups with PRs)
        assert.deepStrictEqual(votes, [0, -5, 10]);
        assert.strictEqual(groups[0].prs.length, 2); // No vote: PR 1, 4
        assert.strictEqual(groups[1].prs.length, 1); // Waiting: PR 3
        assert.strictEqual(groups[2].prs.length, 1); // Approved: PR 2
    });

    test('omits empty groups', () => {
        const prs = [makePr(1, 10), makePr(2, 10)];
        const groups = groupPrsByVote(prs, 'user-1');
        assert.strictEqual(groups.length, 1);
        assert.strictEqual(groups[0].vote, 10);
        assert.strictEqual(groups[0].prs.length, 2);
    });

    test('handles PRs with no reviewers as no-vote', () => {
        const pr = { pullRequestId: 1, title: 'PR 1', reviewers: [] } as any;
        const groups = groupPrsByVote([pr], 'user-1');
        assert.strictEqual(groups.length, 1);
        assert.strictEqual(groups[0].vote, 0);
    });

    test('matches reviewer by id', () => {
        const prs = [makePr(1, 10, 'user-1'), makePr(2, -10, 'user-1')];
        const groups = groupPrsByVote(prs, 'user-1');
        const votes = groups.map(g => g.vote);
        assert.deepStrictEqual(votes, [10, -10]);
    });

    test('treats unknown vote values as no-vote', () => {
        const prs = [makePr(1, 99)];
        const groups = groupPrsByVote(prs, 'user-1');
        assert.strictEqual(groups.length, 1);
        assert.strictEqual(groups[0].vote, 0);
    });

    test('empty PR list returns empty groups', () => {
        const groups = groupPrsByVote([], 'user-1');
        assert.strictEqual(groups.length, 0);
    });
});
