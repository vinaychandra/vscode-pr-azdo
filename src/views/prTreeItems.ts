import * as vscode from 'vscode';
import type { GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';

/** Which category of PR list this represents. */
export type PrCategory = 'allOpen' | 'createdByMe' | 'waitingForReview';

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
