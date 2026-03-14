import * as vscode from 'vscode';
import type { GitPullRequest, GitCommitRef, GitPullRequestChange } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { PullRequestService } from '../azdo/prService';
import type { API } from '../typings/git';
import {
    ActivePrRootItem,
    SectionHeaderItem,
    FolderItem,
    FileChangeItem,
    CommitItem,
    buildFileTree,
    type ActivePrTreeItem,
} from './activePrTreeItems';

/**
 * Provides data for the "Active Pull Request" tree view.
 *
 * Detects the PR for the currently checked-out branch.
 * Shows Files (folder tree from latest iteration) and Commits.
 */
export class ActivePrTreeDataProvider implements vscode.TreeDataProvider<ActivePrTreeItem>, vscode.Disposable {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private readonly _disposables: vscode.Disposable[] = [];

    private _activePr: GitPullRequest | undefined;
    private _fileTree: (FolderItem | FileChangeItem)[] | undefined;
    private _commits: GitCommitRef[] | undefined;

    /** Expose for context key. */
    get _activePrForContext(): GitPullRequest | undefined {
        return this._activePr;
    }

    constructor(
        private readonly prService: PullRequestService,
        private readonly gitApi: API,
        private readonly log: vscode.OutputChannel,
    ) {
        // Listen for branch changes in all known repos
        for (const repo of gitApi.repositories) {
            this.subscribeToBranchChanges(repo);
        }
        this._disposables.push(
            gitApi.onDidOpenRepository(repo => this.subscribeToBranchChanges(repo)),
        );

        // Initial detection
        void this.detectActivePr();
    }

    private subscribeToBranchChanges(repo: import('../typings/git').Repository): void {
        this._disposables.push(
            repo.state.onDidChange(() => {
                void this.detectActivePr();
            }),
        );
    }

    /** Re-detect the active PR for the current branch and refresh the tree. */
    async detectActivePr(): Promise<void> {
        const branchName = this.getCurrentBranchName();
        this.log.appendLine(`[active-pr] Current branch: ${branchName ?? '(detached/unknown)'}`);

        if (!branchName) {
            this.setActivePr(undefined);
            return;
        }

        try {
            const pr = await this.prService.findPrForBranch(branchName);
            this.log.appendLine(
                pr
                    ? `[active-pr] Found PR #${pr.pullRequestId}: ${pr.title}`
                    : `[active-pr] No active PR for branch "${branchName}"`,
            );
            this.setActivePr(pr);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.appendLine(`[active-pr] Error detecting PR: ${msg}`);
            this.setActivePr(undefined);
        }
    }

    refresh(): void {
        this._fileTree = undefined;
        this._commits = undefined;
        this._activePr = undefined;
        void this.detectActivePr();
    }

    private setActivePr(pr: GitPullRequest | undefined): void {
        const changed = pr?.pullRequestId !== this._activePr?.pullRequestId;
        this._activePr = pr;
        if (changed) {
            this._fileTree = undefined;
            this._commits = undefined;
        }
        this._onDidChangeTreeData.fire();
    }

    private getCurrentBranchName(): string | undefined {
        for (const repo of this.gitApi.repositories) {
            const head = repo.state.HEAD;
            if (head?.name) {
                return head.name;
            }
        }
        return undefined;
    }

    getTreeItem(element: ActivePrTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ActivePrTreeItem): Promise<ActivePrTreeItem[]> {
        if (!this._activePr) {
            return [];
        }

        // Root level → PR root item
        if (!element) {
            return [new ActivePrRootItem(this._activePr)];
        }

        // PR root → Files + Commits sections
        if (element instanceof ActivePrRootItem) {
            const [fileCount, commitCount] = await this.ensureData();
            return [
                new SectionHeaderItem('files', 'Files', fileCount),
                new SectionHeaderItem('commits', 'Commits', commitCount),
            ];
        }

        // Files section → folder tree
        if (element instanceof SectionHeaderItem && element.section === 'files') {
            await this.ensureData();
            return this._fileTree ?? [];
        }

        // Commits section → commit items
        if (element instanceof SectionHeaderItem && element.section === 'commits') {
            await this.ensureData();
            return (this._commits ?? []).map(c => new CommitItem(c));
        }

        // Folder → children
        if (element instanceof FolderItem) {
            return element.children;
        }

        return [];
    }

    /**
     * Ensure files and commits data are loaded. Returns [fileCount, commitCount].
     */
    private async ensureData(): Promise<[number, number]> {
        if (this._fileTree && this._commits) {
            return [this.countFiles(this._fileTree), this._commits.length];
        }

        const prId = this._activePr!.pullRequestId!;

        try {
            // Fetch iterations to find the latest one
            const iterations = await this.prService.getPrIterations(prId);
            const latestIteration = iterations[iterations.length - 1];

            if (latestIteration?.id) {
                const iterationChanges = await this.prService.getPrIterationChanges(prId, latestIteration.id);
                const changes = (iterationChanges.changeEntries ?? []) as GitPullRequestChange[];
                this._fileTree = buildFileTree(changes);
                this.log.appendLine(`[active-pr] Loaded ${changes.length} file change(s) from iteration ${latestIteration.id}`);
            } else {
                this._fileTree = [];
            }

            this._commits = await this.prService.getPrCommits(prId);
            this.log.appendLine(`[active-pr] Loaded ${this._commits.length} commit(s)`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.appendLine(`[active-pr] Error loading data: ${msg}`);
            this._fileTree = this._fileTree ?? [];
            this._commits = this._commits ?? [];
        }

        return [this.countFiles(this._fileTree), this._commits.length];
    }

    private countFiles(nodes: (FolderItem | FileChangeItem)[]): number {
        let count = 0;
        for (const node of nodes) {
            if (node instanceof FileChangeItem) {
                count++;
            } else if (node instanceof FolderItem) {
                count += this.countFiles(node.children);
            }
        }
        return count;
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
    }
}
