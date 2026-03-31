import * as vscode from 'vscode';
import type { GitPullRequest, GitCommitRef, GitPullRequestChange, GitPullRequestCommentThread, GitPullRequestIteration } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { CommentType, CommentThreadStatus, VersionControlChangeType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { PullRequestService } from '../azdo/prService';
import { isAuthError } from '../azdo/apiClient';
import type { API } from '../typings/git';
import {
    ActivePrRootItem,
    ReviewModeToggleItem,
    SectionHeaderItem,
    FolderItem,
    FileChangeItem,
    CommentThreadItem,
    DraftCommentItem,
    CommitItem,
    buildFileTree,
    type ActivePrTreeItem,
} from './activePrTreeItems';

export type CommentFilter = 'active' | 'all';

/**
 * Provides data for the "Active Pull Request" tree view.
 *
 * Detects the PR for the currently checked-out branch.
 * Shows Files (folder tree from latest iteration) and Commits.
 */
export class ActivePrTreeDataProvider implements vscode.TreeDataProvider<ActivePrTreeItem>, vscode.Disposable {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private readonly _onDidUpdateComments = new vscode.EventEmitter<void>();
    /** Fires after threads are loaded/filtered — use this to update inline comments. */
    readonly onDidUpdateComments = this._onDidUpdateComments.event;

    private readonly _disposables: vscode.Disposable[] = [];

    private _activePr: GitPullRequest | undefined;
    private _fileTree: (FolderItem | FileChangeItem)[] | undefined;
    private _commits: GitCommitRef[] | undefined;
    /** All user-visible threads (cached from API, never cleared by filter change). */
    private _allThreads: GitPullRequestCommentThread[] | undefined;
    private _iterations: GitPullRequestIteration[] | undefined;
    private _commentFilter: CommentFilter = 'active';
    private _authorFilter: string | null = null;
    private _reviewMode = false;
    private _reviewedFiles = new Set<string>();
    private _changeTypeMap = new Map<string, VersionControlChangeType>();
    private _parentMap = new Map<ActivePrTreeItem, ActivePrTreeItem | undefined>();

    /** Expose for context key. */
    get _activePrForContext(): GitPullRequest | undefined {
        return this._activePr;
    }

    /** Expose cached iterations for the "View Original Context" feature. */
    get iterations(): GitPullRequestIteration[] | undefined {
        return this._iterations;
    }

    /** Expose cached threads for the comment controller. */
    get allThreads(): GitPullRequestCommentThread[] | undefined {
        return this._allThreads;
    }

    /** Get threads filtered by the current comment filter. */
    get filteredThreads(): GitPullRequestCommentThread[] {
        if (!this._allThreads || !this._reviewMode) { return []; }
        return this.applyThreadFilter(this._allThreads);
    }

    /** Get relative paths of all changed files in the PR. */
    get changedFilePaths(): string[] {
        if (!this._fileTree) { return []; }
        return this.collectFilePaths(this._fileTree);
    }

    /** Look up the change type for a file path (relative to repo root). */
    getChangeType(filePath: string): VersionControlChangeType | undefined {
        return this._changeTypeMap.get(filePath);
    }

    private collectFilePaths(nodes: (FolderItem | FileChangeItem)[]): string[] {
        const paths: string[] = [];
        for (const node of nodes) {
            if (node instanceof FileChangeItem) {
                paths.push(node.filePath);
            } else if (node instanceof FolderItem) {
                paths.push(...this.collectFilePaths(node.children));
            }
        }
        return paths;
    }

    /** Get the set of reviewed file paths. */
    get reviewedFiles(): ReadonlySet<string> {
        return this._reviewedFiles;
    }

    /** Replace the entire reviewed files set (e.g. when loading from persisted state). */
    setReviewedFiles(paths: string[]): void {
        this._reviewedFiles = new Set(paths);
        this.applyCheckboxStates();
        this._onDidChangeTreeData.fire();
    }

    /** Mark or unmark a single file as reviewed. Returns the updated full set. */
    markFileReviewed(filePath: string, reviewed: boolean): ReadonlySet<string> {
        if (reviewed) {
            this._reviewedFiles.add(filePath);
        } else {
            this._reviewedFiles.delete(filePath);
        }
        return this._reviewedFiles;
    }

    /** Apply checkbox states to the cached file tree based on _reviewedFiles. */
    applyCheckboxStates(): void {
        if (!this._fileTree) { return; }
        this.applyCheckboxToNodes(this._fileTree);
    }

    private applyCheckboxToNodes(nodes: (FolderItem | FileChangeItem)[]): void {
        for (const node of nodes) {
            if (node instanceof FileChangeItem) {
                node.checkboxState = this._reviewedFiles.has(node.filePath)
                    ? vscode.TreeItemCheckboxState.Checked
                    : vscode.TreeItemCheckboxState.Unchecked;
            } else if (node instanceof FolderItem) {
                this.applyCheckboxToNodes(node.children);
                // Folder is checked if ALL descendant files are checked
                const allChecked = this.allFilesChecked(node.children);
                node.checkboxState = allChecked
                    ? vscode.TreeItemCheckboxState.Checked
                    : vscode.TreeItemCheckboxState.Unchecked;
            }
        }
    }

    private allFilesChecked(nodes: (FolderItem | FileChangeItem)[]): boolean {
        for (const node of nodes) {
            if (node instanceof FileChangeItem) {
                if (!this._reviewedFiles.has(node.filePath)) { return false; }
            } else if (node instanceof FolderItem) {
                if (!this.allFilesChecked(node.children)) { return false; }
            }
        }
        return nodes.length > 0;
    }

    /** Collect all file paths under a folder item. */
    collectDescendantFilePaths(node: FolderItem): string[] {
        const paths: string[] = [];
        for (const child of node.children) {
            if (child instanceof FileChangeItem) {
                paths.push(child.filePath);
            } else if (child instanceof FolderItem) {
                paths.push(...this.collectDescendantFilePaths(child));
            }
        }
        return paths;
    }

    get commentFilter(): CommentFilter {
        return this._commentFilter;
    }

    setCommentFilter(filter: CommentFilter): void {
        this._commentFilter = filter;
        // Rebuild tree items from cached data (no re-fetch)
        this.rebuildCommentsFromCache();
        this._onDidChangeTreeData.fire();
        this._onDidUpdateComments.fire();
    }

    get authorFilter(): string | null {
        return this._authorFilter;
    }

    setAuthorFilter(author: string | null): void {
        this._authorFilter = author;
        this.rebuildCommentsFromCache();
        this._onDidChangeTreeData.fire();
        this._onDidUpdateComments.fire();
    }

    /** Get sorted unique author display names from all cached threads. */
    getUniqueAuthors(): string[] {
        if (!this._allThreads) { return []; }
        const names = new Set<string>();
        for (const thread of this._allThreads) {
            for (const c of thread.comments ?? []) {
                if (!c.isDeleted && c.commentType !== CommentType.System && c.author?.displayName) {
                    names.add(c.author.displayName);
                }
            }
        }
        return [...names].sort((a, b) => a.localeCompare(b));
    }

    /** Enable or disable review mode. When OFF, comments are hidden everywhere. */
    setReviewMode(on: boolean): void {
        if (this._reviewMode === on) { return; }
        this._reviewMode = on;
        this.log.appendLine(`[active-pr] setReviewMode: ${on}`);
        this.rebuildCommentsFromCache();
        this._onDidChangeTreeData.fire();
        this._onDidUpdateComments.fire();
    }

    get reviewMode(): boolean {
        return this._reviewMode;
    }

    /** Optional callback to get draft comment summaries for tree display. */
    private _draftProvider?: () => { filePath: string; line: number; body: string; kind: 'ai' | 'user' | 'reply' }[];

    /** Set the draft provider callback (typically from PrCommentController.getDraftSummaries). */
    setDraftProvider(provider: () => { filePath: string; line: number; body: string; kind: 'ai' | 'user' | 'reply' }[]): void {
        this._draftProvider = provider;
    }

    constructor(
        private readonly prService: PullRequestService,
        private readonly gitApi: API,
        private readonly log: vscode.OutputChannel,
        private readonly onAuthError?: () => void,
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
            if (isAuthError(err)) {
                this.onAuthError?.();
            }
            this.setActivePr(undefined);
        }
    }

    refresh(): void {
        this._fileTree = undefined;
        this._commits = undefined;
        this._allThreads = undefined;
        this._iterations = undefined;
        this._changeTypeMap.clear();
        this._activePr = undefined;
        void this.detectActivePr();
    }

    /**
     * Re-fetch only comment threads without clearing file/commit/iteration caches.
     * Use after a comment action to avoid a full data reload that causes UI flicker.
     */
    async refreshThreadsOnly(): Promise<void> {
        const prId = this._activePr?.pullRequestId;
        if (!prId) { return; }

        this._allThreads = undefined; // clear so loadThreads re-fetches
        await this.loadThreads(prId);
        this.rebuildCommentsFromCache();
        this._onDidChangeTreeData.fire();
        this._onDidUpdateComments.fire();
    }

    private setActivePr(pr: GitPullRequest | undefined): void {
        const changed = pr?.pullRequestId !== this._activePr?.pullRequestId;
        this._activePr = pr;
        if (changed) {
            this._fileTree = undefined;
            this._commits = undefined;
            this._allThreads = undefined;
            this._iterations = undefined;
            this._reviewedFiles.clear();

            const resetFilters = vscode.workspace.getConfiguration('vscode-pr-azdo').get<boolean>('resetFiltersOnPrChange', false);
            if (resetFilters) {
                this._commentFilter = 'active';
                this._authorFilter = null;
            }
        }
        this._onDidChangeTreeData.fire();
        if (changed) {
            this._onDidUpdateComments.fire();
        }
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

    /**
     * Required by {@link vscode.TreeView.reveal} to walk up to the root.
     * Returns the parent element recorded during {@link getChildren}.
     */
    getParent(element: ActivePrTreeItem): ActivePrTreeItem | undefined {
        return this._parentMap.get(element);
    }

    async getChildren(element?: ActivePrTreeItem): Promise<ActivePrTreeItem[]> {
        if (!this._activePr) {
            return [];
        }

        const trackChildren = (parent: ActivePrTreeItem | undefined, children: ActivePrTreeItem[]): ActivePrTreeItem[] => {
            for (const child of children) {
                this._parentMap.set(child, parent);
            }
            return children;
        };

        // Root level → review toggle + PR root item
        if (!element) {
            return trackChildren(undefined, [
                new ReviewModeToggleItem(this._reviewMode, this._allThreads?.length ?? 0),
                new ActivePrRootItem(this._activePr),
            ]);
        }

        // PR root → Files + Commits sections
        if (element instanceof ActivePrRootItem) {
            const [fileCount, commitCount] = await this.ensureData();
            return trackChildren(element, [
                new SectionHeaderItem('files', 'Files', fileCount),
                new SectionHeaderItem('commits', 'Commits', commitCount),
            ]);
        }

        // Files section → filtered PR-level comments + folder tree
        if (element instanceof SectionHeaderItem && element.section === 'files') {
            await this.ensureData();
            const items: ActivePrTreeItem[] = [];
            if (this._reviewMode) {
                const prComments = this.getFilteredPrLevelComments();
                items.push(...prComments);
            }
            items.push(...(this._fileTree ?? []));
            return trackChildren(element, items);
        }

        // Commits section → commit items
        if (element instanceof SectionHeaderItem && element.section === 'commits') {
            await this.ensureData();
            return trackChildren(element, (this._commits ?? []).map(c => new CommitItem(c)));
        }

        // Folder → children
        if (element instanceof FolderItem) {
            return trackChildren(element, element.children);
        }

        // File → comment threads (if review mode is on)
        if (element instanceof FileChangeItem) {
            if (this._reviewMode) {
                return trackChildren(element, this.getFilteredFileComments(element));
            }
            return [];
        }

        return [];
    }

    /**
     * Ensure files, commits, and comments data are loaded. Returns [fileCount, commitCount].
     */
    private async ensureData(): Promise<[number, number]> {
        if (this._fileTree && this._commits) {
            return [this.countFiles(this._fileTree), this._commits.length];
        }

        const prId = this._activePr!.pullRequestId!;

        try {
            // Fetch iterations to find the latest one
            const iterations = await this.prService.getPrIterations(prId);
            this._iterations = iterations;
            const latestIteration = iterations[iterations.length - 1];

            if (latestIteration?.id) {
                const iterationChanges = await this.prService.getPrIterationChanges(prId, latestIteration.id);
                const changes = (iterationChanges.changeEntries ?? []) as GitPullRequestChange[];
                this._fileTree = buildFileTree(changes);
                this._changeTypeMap.clear();
                for (const ch of changes) {
                    const rawPath = (ch as any).item?.path as string | undefined;
                    if (rawPath) {
                        const p = rawPath.startsWith('/') ? rawPath.substring(1) : rawPath;
                        this._changeTypeMap.set(p, (ch as any).changeType ?? VersionControlChangeType.None);
                    }
                }
                this.log.appendLine(`[active-pr] Loaded ${changes.length} file change(s) from iteration ${latestIteration.id}`);
            } else {
                this._fileTree = [];
            }

            this._commits = await this.prService.getPrCommits(prId);
            this.log.appendLine(`[active-pr] Loaded ${this._commits.length} commit(s)`);

            // Always fetch threads (cached until refresh)
            await this.loadThreads(prId);
            this.rebuildCommentsFromCache();
            this.applyCheckboxStates();
            this._onDidUpdateComments.fire();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.appendLine(`[active-pr] Error loading data: ${msg}`);
            if (isAuthError(err)) {
                this.onAuthError?.();
            }
            this._fileTree = this._fileTree ?? [];
            this._commits = this._commits ?? [];
            this._allThreads = this._allThreads ?? [];
        }

        return [this.countFiles(this._fileTree), this._commits.length];
    }

    /** Fetch all threads once and cache them. */
    private async loadThreads(prId: number): Promise<void> {
        if (this._allThreads) { return; }

        const threads = await this.prService.getPrThreads(prId);
        this.log.appendLine(`[active-pr] Loaded ${threads.length} comment thread(s)`);

        // Keep only non-deleted threads with at least one user comment
        this._allThreads = threads.filter(t => {
            if (t.isDeleted) { return false; }
            return t.comments?.some(
                c => !c.isDeleted && c.commentType !== CommentType.System,
            );
        });
        this.log.appendLine(`[active-pr] ${this._allThreads.length} user thread(s) after filtering system/deleted`);
    }

    /** Apply the current filter to cached threads and attach to the file tree. */
    private rebuildCommentsFromCache(): void {
        if (!this._allThreads || !this._fileTree) { return; }

        // Clear existing comment attachments
        this.clearComments(this._fileTree);

        if (!this._reviewMode) { return; }

        const filtered = this.applyThreadFilter(this._allThreads);

        // Partition: file-level vs PR-level
        const byFile = new Map<string, GitPullRequestCommentThread[]>();

        for (const thread of filtered) {
            const filePath = thread.threadContext?.filePath;
            if (filePath) {
                const normalized = filePath.startsWith('/') ? filePath.substring(1) : filePath;
                if (!byFile.has(normalized)) {
                    byFile.set(normalized, []);
                }
                byFile.get(normalized)!.push(thread);
            }
        }

        // Attach to file items
        this.attachCommentsToFiles(this._fileTree, byFile);

        // Attach draft comments to their file items
        if (this._draftProvider) {
            const drafts = this._draftProvider();
            const draftsByFile = new Map<string, DraftCommentItem[]>();
            for (const d of drafts) {
                if (!draftsByFile.has(d.filePath)) {
                    draftsByFile.set(d.filePath, []);
                }
                draftsByFile.get(d.filePath)!.push(new DraftCommentItem(d.filePath, d.line, d.body, d.kind));
            }
            this.attachDraftsToFiles(this._fileTree, draftsByFile);
        }
    }

    private applyThreadFilter(threads: GitPullRequestCommentThread[]): GitPullRequestCommentThread[] {
        let result = threads;

        // Status filter
        if (this._commentFilter !== 'all') {
            result = result.filter(t => {
                const status = t.status;
                return status === undefined
                    || status === CommentThreadStatus.Unknown
                    || status === CommentThreadStatus.Active
                    || status === CommentThreadStatus.Pending;
            });
        }

        // Author filter
        if (this._authorFilter) {
            const author = this._authorFilter;
            result = result.filter(t =>
                t.comments?.some(c => !c.isDeleted && c.commentType !== CommentType.System && c.author?.displayName === author),
            );
        }

        return result;
    }

    /** Get filtered PR-level comments (threads with no file context). */
    private getFilteredPrLevelComments(): CommentThreadItem[] {
        if (!this._allThreads) { return []; }
        const filtered = this.applyThreadFilter(this._allThreads);
        return filtered
            .filter(t => !t.threadContext?.filePath)
            .map(t => new CommentThreadItem(t));
    }

    /** Get filtered comments for a specific file. */
    private getFilteredFileComments(file: FileChangeItem): (CommentThreadItem | DraftCommentItem)[] {
        return file.commentThreads;
    }

    private clearComments(nodes: (FolderItem | FileChangeItem)[]): void {
        for (const node of nodes) {
            if (node instanceof FileChangeItem) {
                node.commentThreads.length = 0;
                node.collapsibleState = vscode.TreeItemCollapsibleState.None;
            } else if (node instanceof FolderItem) {
                this.clearComments(node.children);
            }
        }
    }

    private attachCommentsToFiles(
        nodes: (FolderItem | FileChangeItem)[],
        byFile: Map<string, GitPullRequestCommentThread[]>,
    ): void {
        for (const node of nodes) {
            if (node instanceof FileChangeItem) {
                const threads = byFile.get(node.filePath);
                if (threads) {
                    for (const t of threads) {
                        node.commentThreads.push(new CommentThreadItem(t));
                    }
                    node.finalizeComments();
                }
            } else if (node instanceof FolderItem) {
                this.attachCommentsToFiles(node.children, byFile);
            }
        }
    }

    private attachDraftsToFiles(
        nodes: (FolderItem | FileChangeItem)[],
        draftsByFile: Map<string, DraftCommentItem[]>,
    ): void {
        for (const node of nodes) {
            if (node instanceof FileChangeItem) {
                const drafts = draftsByFile.get(node.filePath);
                if (drafts) {
                    node.commentThreads.push(...drafts);
                    node.finalizeComments();
                }
            } else if (node instanceof FolderItem) {
                this.attachDraftsToFiles(node.children, draftsByFile);
            }
        }
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
        this._onDidUpdateComments.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
    }
}
