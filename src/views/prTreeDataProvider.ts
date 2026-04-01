import * as vscode from 'vscode';
import type { GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { PullRequestService } from '../azdo/prService';
import { isAuthError, type AzDoApiClient } from '../azdo/apiClient';
import { CategoryTreeItem, PullRequestTreeItem, VoteFilterItem, groupPrsByVote, type PrCategory } from './prTreeItems';

export type PrTreeItem = CategoryTreeItem | PullRequestTreeItem | VoteFilterItem;

/**
 * Provides data for the Pull Requests tree view.
 *
 * Root level shows three category nodes. Expanding a category lazily
 * fetches the matching PRs from Azure DevOps.
 */
export class PrTreeDataProvider implements vscode.TreeDataProvider<PrTreeItem>, vscode.Disposable {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<PrTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private readonly _disposables: vscode.Disposable[] = [];

    // Cache fetched PR lists so collapsing/expanding doesn't re-fetch
    private _cache = new Map<PrCategory, GitPullRequest[]>();
    private _cachedUserId: string | undefined;

    constructor(
        private readonly prService: PullRequestService,
        private readonly apiClient: AzDoApiClient,
        private readonly log: vscode.OutputChannel,
        private readonly onAuthError?: () => void,
    ) { }

    /** Force a full refresh of all data. */
    refresh(): void {
        this._cache.clear();
        this._cachedUserId = undefined;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: PrTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: PrTreeItem): Promise<PrTreeItem[]> {
        if (!element) {
            // If not authenticated, show a sign-in prompt instead of categories
            if (!this.apiClient.isConnected) {
                const signIn = new vscode.TreeItem('Sign in to Azure DevOps', vscode.TreeItemCollapsibleState.None);
                signIn.iconPath = new vscode.ThemeIcon('sign-in');
                signIn.command = { command: 'vscode-pr-azdo.signIn', title: 'Sign In' };
                return [signIn as unknown as PrTreeItem];
            }
            return this.getRootCategories();
        }

        if (element instanceof CategoryTreeItem) {
            return this.getPullRequestsForCategory(element);
        }

        if (element instanceof VoteFilterItem) {
            return element.prs.map(pr => new PullRequestTreeItem(pr));
        }

        return [];
    }

    private getRootCategories(): CategoryTreeItem[] {
        return [
            new CategoryTreeItem('allOpen', 'All Open', this._cache.get('allOpen')?.length),
            new CategoryTreeItem('createdByMe', 'Created By Me', this._cache.get('createdByMe')?.length),
            new CategoryTreeItem('waitingForReview', 'Waiting for My Review', this._cache.get('waitingForReview')?.length),
        ];
    }

    private async getPullRequestsForCategory(category: CategoryTreeItem): Promise<PrTreeItem[]> {
        try {
            const cached = this._cache.get(category.category);
            if (cached) {                // For waitingForReview, return vote sub-groups instead of flat PR list
                if (category.category === 'waitingForReview' && this._cachedUserId) {
                    return groupPrsByVote(cached, this._cachedUserId);
                } return cached.map(pr => new PullRequestTreeItem(pr));
            }

            this.log.appendLine(`[tree] Fetching PRs for category: ${category.category}`);

            let prs: GitPullRequest[];
            switch (category.category) {
                case 'allOpen':
                    prs = await this.prService.getOpenPullRequests();
                    break;
                case 'createdByMe': {
                    const userId = await this.apiClient.getCurrentUserId();
                    prs = await this.prService.getMyPullRequests(userId);
                    break;
                }
                case 'waitingForReview': {
                    const userId = await this.apiClient.getCurrentUserId();
                    prs = await this.prService.getPullRequestsAwaitingMyReview(userId);
                    this._cache.set(category.category, prs);
                    this._cachedUserId = userId;
                    this.log.appendLine(`[tree] ${category.category}: ${prs.length} PR(s)`);
                    this._onDidChangeTreeData.fire();
                    return groupPrsByVote(prs, userId);
                }
            }

            this._cache.set(category.category, prs);
            this.log.appendLine(`[tree] ${category.category}: ${prs.length} PR(s)`);

            // Refresh the root so category counts update
            this._onDidChangeTreeData.fire();

            return prs.map(pr => new PullRequestTreeItem(pr));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.appendLine(`[tree] Error fetching ${category.category}: ${msg}`);
            if (isAuthError(err)) {
                this.onAuthError?.();
            } else {
                vscode.window.showErrorMessage(`Failed to load pull requests: ${msg}`);
            }
            return [];
        }
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
    }
}
