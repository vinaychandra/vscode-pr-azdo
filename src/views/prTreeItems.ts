import * as vscode from 'vscode';
import type { GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';

/** Which category of PR list this represents. */
export type PrCategory = 'allOpen' | 'createdByMe' | 'waitingForReview';

/** Vote values used by Azure DevOps. */
export type VoteFilter = 10 | 5 | 0 | -5 | -10;

/** Human-readable labels for each vote filter. */
const VOTE_LABELS: Record<VoteFilter, string> = {
    0: 'No vote yet',
    10: 'Approved',
    5: 'Approved with suggestions',
    [-5]: 'Waiting for author',
    [-10]: 'Rejected',
};

/** Icons for each vote filter. */
const VOTE_ICONS: Record<VoteFilter, string> = {
    0: 'circle-large-outline',
    10: 'check',
    5: 'check',
    [-5]: 'watch',
    [-10]: 'close',
};

/**
 * Top-level grouping node in the PR tree (e.g. "All Open").
 */
export class CategoryTreeItem extends vscode.TreeItem {
    constructor(
        public readonly category: PrCategory,
        label: string,
        public count: number | undefined,
    ) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.contextValue = 'prCategory';
        this.description = count !== undefined ? `${count}` : '';
    }
}

function shortRef(refName: string | undefined): string {
    if (!refName) { return ''; }
    return refName.replace(/^refs\/heads\//, '');
}

/**
 * Leaf node representing a single pull request.
 */
export class PullRequestTreeItem extends vscode.TreeItem {
    constructor(public readonly pr: GitPullRequest) {
        super(pr.title ?? '(untitled)', vscode.TreeItemCollapsibleState.None);

        const author = pr.createdBy?.displayName ?? '';
        const shortAuthor = author.split(' ')[0] || author;
        this.description = `#${pr.pullRequestId} · ${shortAuthor}`;
        this.tooltip = new vscode.MarkdownString(
            `**${pr.title}**  \n` +
            `#${pr.pullRequestId} by ${pr.createdBy?.displayName ?? 'unknown'}  \n` +
            `\`${shortRef(pr.sourceRefName)}\` → \`${shortRef(pr.targetRefName)}\``,
        );
        this.iconPath = new vscode.ThemeIcon(
            pr.isDraft ? 'git-pull-request-draft' : 'git-pull-request',
        );
        this.contextValue = 'pullRequest';

        // Clicking a PR opens the detail webview
        this.command = {
            command: 'vscode-pr-azdo.openPullRequest',
            title: 'Open Pull Request',
            arguments: [pr],
        };
    }
}

/**
 * Sub-category node under "Waiting for My Review" that groups PRs by the current user's vote.
 */
export class VoteFilterItem extends vscode.TreeItem {
    constructor(
        public readonly vote: VoteFilter,
        public readonly prs: GitPullRequest[],
    ) {
        super(VOTE_LABELS[vote], vscode.TreeItemCollapsibleState.Collapsed);
        this.description = `${prs.length}`;
        this.contextValue = 'voteFilter';
        this.iconPath = new vscode.ThemeIcon(VOTE_ICONS[vote]);
    }
}

/**
 * Given a list of PRs from the "waiting for review" query and the current
 * user's ID, group them by the user's vote on each PR.
 *
 * Returns only groups that have at least one PR, ordered by priority:
 * No vote → Waiting for author → Approved with suggestions → Approved → Rejected.
 */
export function groupPrsByVote(prs: GitPullRequest[], userId: string): VoteFilterItem[] {
    const order: VoteFilter[] = [0, -5, 5, 10, -10];
    const buckets = new Map<VoteFilter, GitPullRequest[]>();
    for (const v of order) { buckets.set(v, []); }

    for (const pr of prs) {
        const myReview = (pr.reviewers ?? []).find(
            r => r.id === userId || r.uniqueName === userId,
        );
        const rawVote = myReview?.vote ?? 0;
        // Normalize any unexpected value to 0
        const vote: VoteFilter = order.includes(rawVote as VoteFilter) ? (rawVote as VoteFilter) : 0;
        buckets.get(vote)!.push(pr);
    }

    return order
        .filter(v => buckets.get(v)!.length > 0)
        .map(v => new VoteFilterItem(v, buckets.get(v)!));
}
