import * as vscode from 'vscode';
import type { GitPullRequestCommentThread, Comment as AzDoComment } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { CommentType, CommentThreadStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { hasSuggestion, extractSuggestion, extractCommentText, renderSuggestionAsDiff } from './suggestionRenderer';
import type { PullRequestService } from '../azdo/prService';
import { GIT_CONTENT_SCHEME } from './gitRefContentProvider';

/**
 * Manages VS Code inline comments for PR threads.
 *
 * Supports: display, replies, new comments, and thread status changes.
 */
export class PrCommentController implements vscode.Disposable {
    private readonly _controller: vscode.CommentController;
    private readonly _disposables: vscode.Disposable[] = [];
    private _threads: vscode.CommentThread[] = [];

    /** Map VS Code thread → AzDO thread ID for API calls. */
    private _threadIdMap = new Map<vscode.CommentThread, number>();

    /** Workspace root URI for resolving relative paths. */
    private _workspaceRoot: vscode.Uri | undefined;

    /** Set of file paths (relative) that belong to the active PR. */
    private _prFilePaths = new Set<string>();

    private _prService: PullRequestService | undefined;
    private _prId: number | undefined;

    /** Fires after a comment action so the tree/provider can refresh. */
    private readonly _onDidPerformAction = new vscode.EventEmitter<void>();
    readonly onDidPerformAction = this._onDidPerformAction.event;

    constructor(private readonly log: vscode.OutputChannel) {
        this._controller = vscode.comments.createCommentController(
            'azdo-pr-comments',
            'Azure DevOps PR Comments',
        );

        this.applyCommentingRangeProvider();

        this._workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        this.log.appendLine('[comments] PrCommentController created');
    }

    /**
     * (Re-)assign the commentingRangeProvider on the controller.
     *
     * VS Code caches the result of provideCommentingRanges per document.
     * Re-assigning the provider forces VS Code to invalidate that cache
     * and re-query ranges for every open editor — which is necessary when
     * the PR context (service / file list) changes after documents are
     * already open.
     */
    private applyCommentingRangeProvider(): void {
        this._controller.commentingRangeProvider = {
            provideCommentingRanges: (document: vscode.TextDocument) => {
                const scheme = document.uri.scheme;
                // Only consider workspace files and our git-ref content scheme
                if (scheme !== 'file' && scheme !== GIT_CONTENT_SCHEME) {
                    return [];
                }
                if (!this._prService || !this._prId) {
                    this.log.appendLine(`[comments] provideCommentingRanges: no PR context — returning [] for ${document.uri.toString()}`);
                    return [];
                }
                const inPr = this.isDocumentInPr(document);
                this.log.appendLine(`[comments] provideCommentingRanges: uri=${document.uri.toString()}, inPr=${inPr}`);
                if (inPr) {
                    return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
                }
                return [];
            },
        };
    }

    /** Set the PR context for write operations. */
    setPrContext(prService: PullRequestService | undefined, prId: number | undefined, prFilePaths?: string[]): void {
        this._prService = prService;
        this._prId = prId;
        this._prFilePaths = new Set(prFilePaths ?? []);
        this.log.appendLine(`[comments] setPrContext: prId=${prId}, filePaths=[${[...(prFilePaths ?? [])].join(', ')}]`);

        // Re-assign the commenting range provider so VS Code re-queries
        // provideCommentingRanges for all already-open editors.
        this.applyCommentingRangeProvider();
    }

    /**
     * Check if a document belongs to the active PR (its file is in the changed files list).
     */
    private isDocumentInPr(document: vscode.TextDocument): boolean {
        const root = this._workspaceRoot;
        if (!root) { return false; }

        const uri = document.uri;
        // Support both working file:// and azdo-pr-git:// scheme
        if (uri.scheme === 'file') {
            const relative = vscode.workspace.asRelativePath(uri, false);
            return this._prFilePaths.has(relative);
        }
        if (uri.scheme === GIT_CONTENT_SCHEME) {
            const path = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
            return path !== '__empty__' && this._prFilePaths.has(path);
        }
        return false;
    }

    /** Handle a reply submitted by the user. */
    async handleReply(reply: vscode.CommentReply): Promise<void> {
        if (!this._prService || !this._prId) {
            vscode.window.showWarningMessage('No active PR context for replying.');
            return;
        }

        const threadId = this._threadIdMap.get(reply.thread);
        if (!threadId) {
            vscode.window.showWarningMessage('Cannot identify thread to reply to.');
            return;
        }

        this.log.appendLine(`[comments] Replying to thread ${threadId}: ${reply.text.substring(0, 50)}…`);
        try {
            const created = await this._prService.createComment(this._prId, threadId, reply.text);
            // Optimistically append the new comment to the thread
            const newComments = [...reply.thread.comments, {
                body: new vscode.MarkdownString(reply.text),
                mode: vscode.CommentMode.Preview,
                author: { name: created.author?.displayName ?? 'You' },
                timestamp: created.publishedDate ? new Date(created.publishedDate) : new Date(),
            }];
            reply.thread.comments = newComments;
            this.log.appendLine(`[comments] Reply created successfully.`);
            this._onDidPerformAction.fire();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.appendLine(`[comments] Reply failed: ${msg}`);
            vscode.window.showErrorMessage(`Failed to post reply: ${msg}`);
        }
    }

    /** Handle a new comment created by the user from the gutter. */
    async handleNewComment(reply: vscode.CommentReply): Promise<void> {
        if (!this._prService || !this._prId) {
            vscode.window.showWarningMessage('No active PR context for commenting.');
            return;
        }

        const uri = reply.thread.uri;
        const range = reply.thread.range;
        if (!range) {
            vscode.window.showWarningMessage('Cannot determine line range for comment.');
            reply.thread.dispose();
            return;
        }
        const filePath = this.resolveFilePath(uri);

        if (!filePath) {
            vscode.window.showWarningMessage('Cannot determine file path for comment.');
            reply.thread.dispose();
            return;
        }

        // AzDO uses 1-based positions
        const startLine = range.start.line + 1;
        const startCol = range.start.character + 1;
        const endLine = range.end.line + 1;
        const endCol = range.end.character + 1;

        this.log.appendLine(`[comments] Creating new thread on ${filePath} L${startLine}:${startCol}-L${endLine}:${endCol}`);
        try {
            const created = await this._prService.createThread(
                this._prId,
                reply.text,
                { filePath: `/${filePath}`, startLine, startCol, endLine, endCol },
            );

            // Replace the temporary thread with a proper one
            reply.thread.comments = [{
                body: new vscode.MarkdownString(reply.text),
                mode: vscode.CommentMode.Preview,
                author: { name: created.comments?.[0]?.author?.displayName ?? 'You' },
                timestamp: new Date(),
            }];
            reply.thread.canReply = true;
            reply.thread.label = 'Active';
            if (created.id) {
                this._threadIdMap.set(reply.thread, created.id);
                this._threads.push(reply.thread);
            }

            this.log.appendLine(`[comments] New thread created: id=${created.id}`);
            this._onDidPerformAction.fire();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.appendLine(`[comments] Create thread failed: ${msg}`);
            vscode.window.showErrorMessage(`Failed to create comment: ${msg}`);
            reply.thread.dispose();
        }
    }

    /** Change the status of a thread. */
    async updateThreadStatus(thread: vscode.CommentThread, status: CommentThreadStatus): Promise<void> {
        this.log.appendLine(`[comments] updateThreadStatus called: status=${status}, prService=${!!this._prService}, prId=${this._prId}`);
        this.log.appendLine(`[comments]   thread uri=${thread.uri.toString()}, range=${thread.range?.start.line}-${thread.range?.end.line}, contextValue=${thread.contextValue}`);
        this.log.appendLine(`[comments]   threadIdMap size=${this._threadIdMap.size}, entries=[${[...this._threadIdMap.values()].join(',')}]`);
        if (!this._prService || !this._prId) {
            this.log.appendLine(`[comments]   BAIL: no PR context`);
            return;
        }

        const threadId = this._threadIdMap.get(thread);
        this.log.appendLine(`[comments]   looked up threadId=${threadId}`);
        if (!threadId) {
            this.log.appendLine(`[comments]   BAIL: thread not found in threadIdMap`);
            vscode.window.showWarningMessage('Cannot identify thread.');
            return;
        }

        const label = statusLabel(status);
        this.log.appendLine(`[comments] Updating thread ${threadId} status → ${label}`);
        try {
            await this._prService.updateThreadStatus(this._prId, threadId, status);
            thread.label = label;
            this.log.appendLine(`[comments] Thread status updated.`);
            this._onDidPerformAction.fire();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.appendLine(`[comments] Status update failed: ${msg}`);
            vscode.window.showErrorMessage(`Failed to update thread status: ${msg}`);
        }
    }

    /** Resolve a URI to a relative file path. */
    private resolveFilePath(uri: vscode.Uri): string | undefined {
        if (uri.scheme === 'file') {
            return vscode.workspace.asRelativePath(uri, false);
        }
        if (uri.scheme === GIT_CONTENT_SCHEME) {
            const path = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
            return path === '__empty__' ? undefined : path;
        }
        return undefined;
    }

    /** Get the AzDO thread ID for a VS Code comment thread (used by status commands). */
    getThreadId(thread: vscode.CommentThread): number | undefined {
        return this._threadIdMap.get(thread);
    }

    /**
     * Update the displayed comments from a set of AzDO threads.
     * Call this whenever the active PR changes, data is refreshed,
     * or the comment filter changes.
     */
    async updateThreads(threads: GitPullRequestCommentThread[] | undefined): Promise<void> {
        // Dispose previous VS Code comment threads
        this.disposeThreads();

        if (!threads || threads.length === 0) {
            this.log.appendLine('[comments] No threads to display');
            return;
        }

        const root = this._workspaceRoot;
        if (!root) {
            this.log.appendLine('[comments] No workspace root — cannot resolve file paths');
            return;
        }

        let created = 0;
        for (const azdoThread of threads) {
            const filePath = azdoThread.threadContext?.filePath;
            if (!filePath) {
                continue; // PR-level comment — skip for inline display
            }

            // Resolve to workspace URI
            const relativePath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
            const fileUri = vscode.Uri.joinPath(root, relativePath);

            this.log.appendLine(`[comments] Creating thread for ${relativePath} at ${fileUri.toString()}`);

            // Determine line range from thread context
            const range = this.getRange(azdoThread);
            this.log.appendLine(`[comments]   range: L${range.start.line + 1}:${range.start.character + 1} - L${range.end.line + 1}:${range.end.character + 1}`);

            // Build comment objects from the thread's comments
            const comments = await this.buildComments(azdoThread, fileUri, range);
            if (comments.length === 0) {
                continue;
            }

            const thread = this._controller.createCommentThread(fileUri, range, comments);
            thread.canReply = !!this._prService; // Enable replies when we have a PR context
            thread.label = this.getThreadLabel(azdoThread);
            thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
            thread.contextValue = 'azdoPrThread'; // For menu contributions

            // Map this VS Code thread to its AzDO ID for API calls
            if (azdoThread.id) {
                this._threadIdMap.set(thread, azdoThread.id);
            }

            this._threads.push(thread);
            created++;
        }

        this.log.appendLine(`[comments] Created ${created} inline comment thread(s)`);
    }

    private getRange(thread: GitPullRequestCommentThread): vscode.Range {
        const ctx = thread.threadContext;
        // Use rightFileStart/End (the "after" side of the diff)
        const startLine = ctx?.rightFileStart?.line ?? ctx?.leftFileStart?.line ?? 1;
        const startCol = ctx?.rightFileStart?.offset ?? 1;
        const endLine = ctx?.rightFileEnd?.line ?? startLine;
        const endCol = ctx?.rightFileEnd?.offset ?? startCol;

        // AzDO positions are 1-based, VS Code Range is 0-based
        return new vscode.Range(
            Math.max(0, startLine - 1),
            Math.max(0, startCol - 1),
            Math.max(0, endLine - 1),
            Math.max(0, endCol - 1),
        );
    }

    private async buildComments(
        thread: GitPullRequestCommentThread,
        fileUri: vscode.Uri,
        range: vscode.Range,
    ): Promise<vscode.Comment[]> {
        const comments = (thread.comments ?? [])
            .filter(c => !c.isDeleted && c.commentType !== CommentType.System);

        // Pre-fetch original text (needed if any comment has a suggestion)
        let originalLines: string[] | undefined;
        let replacedLines: string[] | undefined;
        const needsOriginal = comments.some(c => c.content && hasSuggestion(c.content));
        if (needsOriginal) {
            const result = await this.getOriginalAndReplaced(fileUri, range, thread);
            originalLines = result.original;
            // replacedLines will be computed per-suggestion below
        }

        return comments.map(c => {
            const content = c.content ?? '';

            if (hasSuggestion(content) && originalLines) {
                const suggested = extractSuggestion(content)!;
                const commentText = extractCommentText(content);

                // Build the replaced version: full lines with only the selected span swapped
                replacedLines = this.buildReplacedLines(originalLines, range, suggested);
                const diffMd = renderSuggestionAsDiff(originalLines, suggested, commentText || undefined, replacedLines);

                const body = new vscode.MarkdownString(diffMd);
                body.isTrusted = true;
                return {
                    body,
                    mode: vscode.CommentMode.Preview,
                    author: { name: c.author?.displayName ?? 'Unknown' },
                    timestamp: c.publishedDate ? new Date(c.publishedDate) : undefined,
                };
            }

            return {
                body: new vscode.MarkdownString(content),
                mode: vscode.CommentMode.Preview,
                author: { name: c.author?.displayName ?? 'Unknown' },
                timestamp: c.publishedDate ? new Date(c.publishedDate) : undefined,
            };
        });
    }

    /**
     * Read the original lines from a file at the given range.
     */
    private async getOriginalAndReplaced(
        fileUri: vscode.Uri,
        range: vscode.Range,
        _thread: GitPullRequestCommentThread,
    ): Promise<{ original: string[] }> {
        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            const lines: string[] = [];
            for (let i = range.start.line; i <= range.end.line; i++) {
                if (i < doc.lineCount) {
                    lines.push(doc.lineAt(i).text);
                }
            }
            return { original: lines };
        } catch {
            return { original: [] };
        }
    }

    /**
     * Build the "after" lines by replacing the selected span in the original
     * lines with the suggestion text.
     *
     * The range specifies the exact character span that the suggestion replaces.
     * We keep the text before the start column on the first line and after the
     * end column on the last line, and insert the suggestion in between.
     */
    private buildReplacedLines(
        originalLines: string[],
        range: vscode.Range,
        suggestion: string,
    ): string[] {
        if (originalLines.length === 0) {
            return suggestion.split('\n');
        }

        const prefix = originalLines[0].substring(0, range.start.character);
        const lastLine = originalLines[originalLines.length - 1];
        const suffix = lastLine.substring(range.end.character);

        const suggestedLines = suggestion.split('\n');
        // Prepend prefix to first suggested line, append suffix to last
        suggestedLines[0] = prefix + suggestedLines[0];
        suggestedLines[suggestedLines.length - 1] = suggestedLines[suggestedLines.length - 1] + suffix;

        return suggestedLines;
    }

    private getThreadLabel(thread: GitPullRequestCommentThread): string {
        const status = thread.status;
        switch (status) {
            case 1: return 'Active';
            case 2: return 'Fixed';
            case 3: return "Won't Fix";
            case 4: return 'Closed';
            case 5: return 'By Design';
            case 6: return 'Pending';
            default: return '';
        }
    }

    private disposeThreads(): void {
        for (const t of this._threads) {
            t.dispose();
        }
        this._threads = [];
        this._threadIdMap.clear();
    }

    dispose(): void {
        this.disposeThreads();
        this._controller.dispose();
        this._onDidPerformAction.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
    }
}

function statusLabel(status: CommentThreadStatus): string {
    switch (status) {
        case CommentThreadStatus.Active: return 'Active';
        case CommentThreadStatus.Fixed: return 'Fixed';
        case CommentThreadStatus.WontFix: return "Won't Fix";
        case CommentThreadStatus.Closed: return 'Closed';
        case CommentThreadStatus.ByDesign: return 'By Design';
        case CommentThreadStatus.Pending: return 'Pending';
        default: return '';
    }
}
