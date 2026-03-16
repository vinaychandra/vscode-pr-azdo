import * as vscode from 'vscode';
import type { GitPullRequestCommentThread, Comment as AzDoComment, CommentTrackingCriteria } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { CommentType, CommentThreadStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { hasSuggestion, extractSuggestion, extractCommentText, renderSuggestionAsDiff } from './suggestionRenderer';
import type { PullRequestService } from '../azdo/prService';
import { GIT_CONTENT_SCHEME } from './gitRefContentProvider';
import type { API } from '../typings/git';

/** URI scheme for the virtual PR-level comments document. */
export const PR_COMMENTS_SCHEME = 'azdo-pr-comments';

/** Stored metadata for a VS Code comment thread. */
interface ThreadMeta {
    id: number;
    azdoThread: GitPullRequestCommentThread;
}

/**
 * Manages VS Code inline comments for PR threads.
 *
 * Supports: display, replies, new comments, and thread status changes.
 */
export class PrCommentController implements vscode.Disposable {
    private readonly _controller: vscode.CommentController;
    private readonly _disposables: vscode.Disposable[] = [];
    private _threads: vscode.CommentThread[] = [];

    /** AI-generated draft comment threads (local only, not posted to AzDO). */
    private _draftThreads: vscode.CommentThread[] = [];

    /** Map VS Code thread → AzDO thread metadata for API calls. */
    private _threadMetaMap = new Map<vscode.CommentThread, ThreadMeta>();

    /** Resolve the root URI for mapping repo-relative paths to file URIs. */
    private get _workspaceRoot(): vscode.Uri | undefined {
        return this.gitApi?.repositories[0]?.rootUri
            ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    }

    /** Set of file paths (relative) that belong to the active PR. */
    private _prFilePaths = new Set<string>();

    private _prService: PullRequestService | undefined;
    private _prId: number | undefined;
    private _currentUserId: string | undefined;

    /** When false, the "+" gutter and inline threads are suppressed. */
    private _reviewMode = false;

    /** The last set of threads passed to updateThreads (kept for re-apply on mode change). */
    private _lastThreads: GitPullRequestCommentThread[] | undefined;

    /** Fires after a comment action so the tree/provider can refresh. */
    private readonly _onDidPerformAction = new vscode.EventEmitter<void>();
    readonly onDidPerformAction = this._onDidPerformAction.event;

    constructor(private readonly log: vscode.OutputChannel, private readonly gitApi?: API) {
        this._controller = vscode.comments.createCommentController(
            'azdo-pr-comments',
            'Azure DevOps PR Comments',
        );

        this.applyCommentingRangeProvider();

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
                if (!this._reviewMode) {
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

    /** Enable or disable review mode (controls gutter "+" and inline threads). */
    setReviewMode(on: boolean): void {
        if (this._reviewMode === on) { return; }
        this._reviewMode = on;
        this.log.appendLine(`[comments] setReviewMode: ${on}`);
        this.applyCommentingRangeProvider();
        // Re-apply cached threads: show them if ON, hide if OFF
        void this.updateThreads(this._lastThreads);
    }

    get reviewMode(): boolean {
        return this._reviewMode;
    }

    /** Set the PR context for write operations. */
    setPrContext(prService: PullRequestService | undefined, prId: number | undefined, prFilePaths?: string[], currentUserId?: string): void {
        this._prService = prService;
        this._prId = prId;
        this._prFilePaths = new Set(prFilePaths ?? []);
        this._currentUserId = currentUserId;
        this.log.appendLine(`[comments] setPrContext: prId=${prId}, userId=${currentUserId ?? '(none)'}, filePaths=[${[...(prFilePaths ?? [])].join(', ')}]`);

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
            // Compute path relative to repo root (not workspace folder)
            const rootPath = root.path;
            const filePath = uri.path;
            if (filePath.startsWith(rootPath + '/')) {
                const relative = filePath.substring(rootPath.length + 1);
                return this._prFilePaths.has(relative);
            }
            // Fallback: try workspace-relative
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

        const threadId = this._threadMetaMap.get(reply.thread)?.id;
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
                this._threadMetaMap.set(reply.thread, { id: created.id, azdoThread: created });
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
        this.log.appendLine(`[comments]   threadMetaMap size=${this._threadMetaMap.size}, entries=[${[...this._threadMetaMap.values()].map(m => m.id).join(',')}]`);
        if (!this._prService || !this._prId) {
            this.log.appendLine(`[comments]   BAIL: no PR context`);
            return;
        }

        const threadId = this._threadMetaMap.get(thread)?.id;
        this.log.appendLine(`[comments]   looked up threadId=${threadId}`);
        if (!threadId) {
            this.log.appendLine(`[comments]   BAIL: thread not found in threadMetaMap`);
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

    /** Resolve a URI to a repo-relative file path. */
    private resolveFilePath(uri: vscode.Uri): string | undefined {
        if (uri.scheme === 'file') {
            // Use repo root for relative path, not workspace folder
            const root = this._workspaceRoot;
            if (root) {
                const rootPath = root.path;
                const filePath = uri.path;
                if (filePath.startsWith(rootPath + '/')) {
                    return filePath.substring(rootPath.length + 1);
                }
            }
            // Fallback to workspace-relative
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
        return this._threadMetaMap.get(thread)?.id;
    }

    /** Find the parent thread that contains a given comment. */
    findThreadForComment(comment: vscode.Comment): vscode.CommentThread | undefined {
        for (const thread of this._threads) {
            if (Array.from(thread.comments).includes(comment)) {
                return thread;
            }
        }
        return undefined;
    }

    /**
     * Find the AzDO comment ID for a VS Code Comment within a thread.
     * Matches by author name and timestamp to find the corresponding AzDO comment.
     */
    getAzdoCommentId(thread: vscode.CommentThread, comment: vscode.Comment): number | undefined {
        const meta = this._threadMetaMap.get(thread);
        if (!meta) {
            this.log.appendLine(`[comments] getAzdoCommentId: no meta for thread`);
            return undefined;
        }
        const azdoComments = (meta.azdoThread.comments ?? [])
            .filter(c => !c.isDeleted && c.commentType !== CommentType.System);

        // Try reference match first
        const idx = Array.from(thread.comments).indexOf(comment);
        if (idx >= 0 && idx < azdoComments.length) {
            this.log.appendLine(`[comments] getAzdoCommentId: matched by index ${idx} → commentId=${azdoComments[idx].id}`);
            return azdoComments[idx].id;
        }

        // Fallback: match by author name + timestamp
        const authorName = typeof comment.author.name === 'string' ? comment.author.name : '';
        const timestamp = comment.timestamp?.getTime();
        for (const c of azdoComments) {
            const azdoTime = c.publishedDate ? new Date(c.publishedDate).getTime() : undefined;
            if (c.author?.displayName === authorName && azdoTime === timestamp) {
                this.log.appendLine(`[comments] getAzdoCommentId: matched by author+time → commentId=${c.id}`);
                return c.id;
            }
        }

        this.log.appendLine(`[comments] getAzdoCommentId: no match found (threadComments=${thread.comments.length}, azdoComments=${azdoComments.length}, author=${authorName})`);
        return undefined;
    }

    /** Delete a comment from a thread and update the UI. */
    async handleDeleteComment(thread: vscode.CommentThread, comment: vscode.Comment): Promise<void> {
        if (!this._prService || !this._prId) {
            vscode.window.showWarningMessage('No active PR context.');
            return;
        }
        const threadId = this.getThreadId(thread);
        const commentId = this.getAzdoCommentId(thread, comment);
        if (!threadId || !commentId) {
            vscode.window.showWarningMessage('Cannot identify comment to delete.');
            return;
        }

        this.log.appendLine(`[comments] Deleting comment ${commentId} from thread ${threadId}`);
        try {
            await this._prService.deleteComment(this._prId, threadId, commentId);
            // Remove the comment from the thread UI
            thread.comments = thread.comments.filter(c => c !== comment);
            if (thread.comments.length === 0) {
                thread.dispose();
                this._threads = this._threads.filter(t => t !== thread);
                this._threadMetaMap.delete(thread);
            }
            this.log.appendLine(`[comments] Comment ${commentId} deleted.`);
            this._onDidPerformAction.fire();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.appendLine(`[comments] Delete failed: ${msg}`);
            vscode.window.showErrorMessage(`Failed to delete comment: ${msg}`);
        }
    }

    /** Get the full AzDO thread data for a VS Code comment thread. */
    getAzdoThread(thread: vscode.CommentThread): GitPullRequestCommentThread | undefined {
        return this._threadMetaMap.get(thread)?.azdoThread;
    }

    /**
     * Get the original context info for a comment thread.
     * Returns iteration ID + original file path + original line range,
     * or undefined if the thread has no iteration context.
     */
    getOriginalContext(thread: vscode.CommentThread): {
        iterationId: number;
        filePath: string;
        startLine: number;
        startCol: number;
        endLine: number;
        endCol: number;
        azdoThread: GitPullRequestCommentThread;
    } | undefined {
        const meta = this._threadMetaMap.get(thread);
        if (!meta) { return undefined; }

        const azdoThread = meta.azdoThread;
        const prCtx = (azdoThread as any).pullRequestThreadContext;
        const iterationId = prCtx?.iterationContext?.secondComparingIteration;
        if (!iterationId) { return undefined; }

        // Prefer original (pre-tracking) positions, fall back to current tracked positions
        const tracking: CommentTrackingCriteria | undefined = prCtx?.trackingCriteria;
        const origFilePath = tracking?.origFilePath
            ?? azdoThread.threadContext?.filePath;
        if (!origFilePath) { return undefined; }

        const startLine = tracking?.origRightFileStart?.line
            ?? azdoThread.threadContext?.rightFileStart?.line
            ?? 1;
        const startCol = tracking?.origRightFileStart?.offset
            ?? azdoThread.threadContext?.rightFileStart?.offset
            ?? 1;
        const endLine = tracking?.origRightFileEnd?.line
            ?? azdoThread.threadContext?.rightFileEnd?.line
            ?? startLine;
        const endCol = tracking?.origRightFileEnd?.offset
            ?? azdoThread.threadContext?.rightFileEnd?.offset
            ?? startCol;

        const filePath = origFilePath.startsWith('/') ? origFilePath.substring(1) : origFilePath;

        return { iterationId, filePath, startLine, startCol, endLine, endCol, azdoThread };
    }

    /**
     * Build rendered VS Code comments for an AzDO thread against a specific file URI and range.
     * This fetches the file content at that URI to properly render suggestion diffs.
     */
    async buildCommentsForUri(
        azdoThread: GitPullRequestCommentThread,
        fileUri: vscode.Uri,
        range: vscode.Range,
    ): Promise<vscode.Comment[]> {
        return this.buildComments(azdoThread, fileUri, range);
    }

    /**
     * Update the displayed comments from a set of AzDO threads.
     * Call this whenever the active PR changes, data is refreshed,
     * or the comment filter changes.
     */
    async updateThreads(threads: GitPullRequestCommentThread[] | undefined): Promise<void> {
        // Cache the threads so we can re-apply when review mode toggles
        this._lastThreads = threads;

        // Dispose previous VS Code comment threads
        this.disposeThreads();

        if (!this._reviewMode) {
            this.log.appendLine('[comments] Review mode OFF — not displaying threads');
            return;
        }

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
        let prLevelLine = 0; // Line counter for PR-level comments on the virtual doc
        const prLevelUri = vscode.Uri.parse(`${PR_COMMENTS_SCHEME}:///PR-Comments`);

        for (const azdoThread of threads) {
            const filePath = azdoThread.threadContext?.filePath;
            if (!filePath) {
                // PR-level comment — place on the virtual document
                const range = new vscode.Range(prLevelLine, 0, prLevelLine, 0);
                const comments = (azdoThread.comments ?? [])
                    .filter(c => !c.isDeleted && c.commentType !== CommentType.System)
                    .map(c => ({
                        body: new vscode.MarkdownString(c.content ?? ''),
                        mode: vscode.CommentMode.Preview,
                        author: { name: c.author?.displayName ?? 'Unknown' },
                        contextValue: (this._currentUserId && c.author?.id === this._currentUserId) ? 'ownComment' : undefined,
                        timestamp: c.publishedDate ? new Date(c.publishedDate) : undefined,
                    } as vscode.Comment));
                if (comments.length === 0) { continue; }

                const thread = this._controller.createCommentThread(prLevelUri, range, comments);
                thread.canReply = !!this._prService;
                thread.label = this.getThreadLabel(azdoThread);
                thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
                thread.contextValue = 'azdoPrThread';
                if (azdoThread.id) {
                    this._threadMetaMap.set(thread, { id: azdoThread.id, azdoThread });
                }
                this._threads.push(thread);
                // Re-assign to force VS Code to evaluate comment contextValues for menu buttons
                thread.comments = [...thread.comments];
                prLevelLine += comments.length + 2; // Space between threads
                created++;
                continue;
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

            // Map this VS Code thread to its AzDO metadata for API calls
            if (azdoThread.id) {
                this._threadMetaMap.set(thread, { id: azdoThread.id, azdoThread });
            }

            this._threads.push(thread);
            // Re-assign to force VS Code to evaluate comment contextValues for menu buttons
            thread.comments = [...thread.comments];
            created++;
        }

        this.log.appendLine(`[comments] Created ${created} inline comment thread(s)`);
    }

    private getRange(thread: GitPullRequestCommentThread): vscode.Range {
        const ctx = thread.threadContext;
        // Use rightFileStart/End (the "after" side of the diff), fall back to left side
        const startLine = ctx?.rightFileStart?.line ?? ctx?.leftFileStart?.line ?? 1;
        const startCol = ctx?.rightFileStart?.offset ?? ctx?.leftFileStart?.offset ?? 1;
        const endLine = ctx?.rightFileEnd?.line ?? ctx?.leftFileEnd?.line ?? startLine;
        const endCol = ctx?.rightFileEnd?.offset ?? ctx?.leftFileEnd?.offset ?? startCol;

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
            const isOwnComment = !!(this._currentUserId && c.author?.id === this._currentUserId);
            this.log.appendLine(`[comments]   comment by ${c.author?.displayName} (id=${c.author?.id}), currentUser=${this._currentUserId}, isOwn=${isOwnComment}`);

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
                    contextValue: isOwnComment ? 'ownComment' : undefined,
                    timestamp: c.publishedDate ? new Date(c.publishedDate) : undefined,
                } as vscode.Comment;
            }

            return {
                body: new vscode.MarkdownString(content),
                mode: vscode.CommentMode.Preview,
                author: { name: c.author?.displayName ?? 'Unknown' },
                contextValue: isOwnComment ? 'ownComment' : undefined,
                timestamp: c.publishedDate ? new Date(c.publishedDate) : undefined,
            } as vscode.Comment;
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
        this._threadMetaMap.clear();
    }

    /**
     * Create a read-only comment thread on an arbitrary URI (used for "View Original Context" diffs).
     * The thread is tracked so it gets disposed when the main threads are cleared.
     */
    createThreadOnUri(uri: vscode.Uri, range: vscode.Range, comments: vscode.Comment[]): vscode.CommentThread {
        const thread = this._controller.createCommentThread(uri, range, comments);
        this._threads.push(thread);
        return thread;
    }

    /**
     * Create a draft comment thread (AI review suggestion, local only).
     * The thread is styled differently and tracked separately from real AzDO threads.
     */
    createDraftThread(filePath: string, line: number, commentBody: string, type?: string): vscode.CommentThread | undefined {
        const root = this._workspaceRoot;
        if (!root) { return undefined; }

        const fileUri = vscode.Uri.joinPath(root, filePath);
        const range = new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0);

        const typeLabel = type ? ` (${type})` : '';
        const thread = this._controller.createCommentThread(fileUri, range, [{
            body: new vscode.MarkdownString(commentBody),
            mode: vscode.CommentMode.Editing,
            author: { name: `AI Review${typeLabel}` },
        }]);
        thread.canReply = true;
        thread.label = '✨ AI Draft';
        thread.contextValue = 'azdoPrDraft';
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;

        this._draftThreads.push(thread);
        this.log.appendLine(`[comments] Created draft thread on ${filePath} L${line}: ${commentBody.substring(0, 60)}...`);
        return thread;
    }

    /** Dispose a single draft thread. */
    disposeDraft(thread: vscode.CommentThread): void {
        const idx = this._draftThreads.indexOf(thread);
        if (idx >= 0) {
            this._draftThreads.splice(idx, 1);
            thread.dispose();
            this.log.appendLine('[comments] Draft dismissed');
        }
    }

    /** Dispose all draft threads. */
    clearDrafts(): void {
        for (const t of this._draftThreads) {
            t.dispose();
        }
        const count = this._draftThreads.length;
        this._draftThreads = [];
        this.log.appendLine(`[comments] Cleared ${count} draft(s)`);
    }

    /** Check if a thread is a draft. */
    isDraft(thread: vscode.CommentThread): boolean {
        return this._draftThreads.includes(thread);
    }

    /** Get info about a draft thread for posting. */
    getDraftInfo(thread: vscode.CommentThread): { filePath: string; line: number; body: string } | undefined {
        if (!this.isDraft(thread)) { return undefined; }
        const filePath = this.resolveFilePath(thread.uri);
        if (!filePath) { return undefined; }
        const line = (thread.range?.start.line ?? 0) + 1;
        const body = thread.comments[0]?.body;
        const text = typeof body === 'string' ? body : (body as vscode.MarkdownString)?.value ?? '';
        return { filePath, line, body: text };
    }

    get draftCount(): number {
        return this._draftThreads.length;
    }

    dispose(): void {
        this.disposeThreads();
        this.clearDrafts();
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
