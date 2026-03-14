import * as vscode from 'vscode';
import type { GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { CommentType } from 'azure-devops-node-api/interfaces/GitInterfaces';

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
    updateThreads(threads: GitPullRequestCommentThread[] | undefined): void {
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
            const comments = this.buildComments(azdoThread);
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

    private buildComments(thread: GitPullRequestCommentThread): vscode.Comment[] {
        const comments = (thread.comments ?? [])
            .filter(c => !c.isDeleted && c.commentType !== CommentType.System);

        return comments.map(c => ({
            body: new vscode.MarkdownString(c.content ?? ''),
            mode: vscode.CommentMode.Preview,
            author: {
                name: c.author?.displayName ?? 'Unknown',
            },
            timestamp: c.publishedDate ? new Date(c.publishedDate) : undefined,
        }));
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
