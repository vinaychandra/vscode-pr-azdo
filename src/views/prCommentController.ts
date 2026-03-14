import * as vscode from 'vscode';
import type { GitPullRequestCommentThread, Comment as AzDoComment } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { CommentType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { hasSuggestion, extractSuggestion, extractCommentText, renderSuggestionAsDiff } from './suggestionRenderer';

/**
 * Manages VS Code inline comments for PR threads.
 *
 * Uses the `vscode.comments` API to display PR comment threads
 * directly in the editor at their original line positions.
 */
export class PrCommentController implements vscode.Disposable {
    private readonly _controller: vscode.CommentController;
    private readonly _disposables: vscode.Disposable[] = [];
    private _threads: vscode.CommentThread[] = [];

    /** Workspace root URI for resolving relative paths. */
    private _workspaceRoot: vscode.Uri | undefined;

    constructor(private readonly log: vscode.OutputChannel) {
        this._controller = vscode.comments.createCommentController(
            'azdo-pr-comments',
            'Azure DevOps PR Comments',
        );
        // Don't show a "comment" action in the gutter — read-only for now
        this._controller.commentingRangeProvider = undefined;

        this._workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;

        this.log.appendLine('[comments] PrCommentController created');
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
            thread.canReply = false;
            thread.label = this.getThreadLabel(azdoThread);
            thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
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
    }

    dispose(): void {
        this.disposeThreads();
        this._controller.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
    }
}
