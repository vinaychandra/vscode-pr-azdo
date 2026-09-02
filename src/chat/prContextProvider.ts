import type { GitPullRequestCommentThread, GitPullRequest, GitPullRequestIteration } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { CommentType } from 'azure-devops-node-api/interfaces/GitInterfaces';

/**
 * Describes the active comment context for the AI assistant.
 * Set when the user clicks the $(sparkle) button on a comment thread.
 */
export interface CommentContext {
    /** The full AzDO comment thread. */
    thread: GitPullRequestCommentThread;
    /** Relative file path (no leading slash). */
    filePath: string;
    /** 1-based start line of the comment. */
    startLine: number;
    /** 1-based start column (offset) of the comment. */
    startCol: number;
    /** 1-based end line of the comment. */
    endLine: number;
    /** 1-based end column (offset) of the comment. */
    endCol: number;
}

/**
 * In-memory store that bridges the comment thread button click
 * and the Chat Participant handler.
 */
export class PrContextProvider {
    private _commentContext: CommentContext | undefined;
    private _activePr: GitPullRequest | undefined;
    private _changedFilePaths: string[] = [];
    private _iterations: GitPullRequestIteration[] = [];
    private _reviewMode: 'workingTree' | 'snapshot' = 'workingTree';
    private _sourceRef: string | undefined;
    private _targetRef: string | undefined;

    /** Set the active comment context (called when the sparkle button is clicked). */
    setCommentContext(ctx: CommentContext | undefined): void {
        this._commentContext = ctx;
    }

    /** Get and consume the active comment context. */
    consumeCommentContext(): CommentContext | undefined {
        const ctx = this._commentContext;
        this._commentContext = undefined;
        return ctx;
    }

    /** Peek at the active comment context without consuming it. */
    peekCommentContext(): CommentContext | undefined {
        return this._commentContext;
    }

    /** Update the active PR metadata. */
    setActivePr(
        pr: GitPullRequest | undefined,
        changedFilePaths?: string[],
        iterations?: GitPullRequestIteration[],
        reviewContext?: { mode: 'workingTree' | 'snapshot'; sourceRef?: string; targetRef?: string },
    ): void {
        this._activePr = pr;
        this._changedFilePaths = changedFilePaths ?? [];
        this._iterations = iterations ?? [];
        this._reviewMode = reviewContext?.mode ?? 'workingTree';
        this._sourceRef = reviewContext?.sourceRef;
        this._targetRef = reviewContext?.targetRef;
    }

    get activePr(): GitPullRequest | undefined {
        return this._activePr;
    }

    get changedFilePaths(): string[] {
        return this._changedFilePaths;
    }

    get iterations(): GitPullRequestIteration[] {
        return this._iterations;
    }

    get isSnapshotReview(): boolean {
        return this._reviewMode === 'snapshot';
    }

    get sourceRef(): string | undefined {
        return this._sourceRef;
    }

    get targetRef(): string | undefined {
        return this._targetRef;
    }

    /**
     * Resolve the source commit SHA for the iteration in which a comment was made.
     * Returns undefined if iteration info is not available.
     */
    resolveSourceCommit(thread: GitPullRequestCommentThread): string | undefined {
        const prCtx = (thread as any).pullRequestThreadContext;
        const iterationId = prCtx?.iterationContext?.secondComparingIteration;
        if (!iterationId) { return undefined; }
        const iteration = this._iterations.find(i => i.id === iterationId);
        return iteration?.sourceRefCommit?.commitId;
    }

    /** Resolve the commit containing the side on which a comment was created. */
    resolveCommentCommit(thread: GitPullRequestCommentThread): string | undefined {
        const prCtx = (thread as any).pullRequestThreadContext;
        const iterationId = prCtx?.iterationContext?.secondComparingIteration;
        const iteration = this._iterations.find(i => i.id === iterationId);
        const leftOnly = !thread.threadContext?.rightFileStart && !!thread.threadContext?.leftFileStart;
        if (leftOnly) {
            return iteration?.targetRefCommit?.commitId
                ?? iteration?.commonRefCommit?.commitId
                ?? this._targetRef;
        }
        return iteration?.sourceRefCommit?.commitId ?? this._sourceRef;
    }

    /**
     * Build a text summary of the comment thread for inclusion in an LM prompt.
     */
    formatThreadForPrompt(thread: GitPullRequestCommentThread): string {
        const parts: string[] = [];
        const rawPath = thread.threadContext?.filePath;
        const filePath = rawPath
            ? (rawPath.startsWith('/') ? rawPath.substring(1) : rawPath)
            : '(PR-level comment)';
        const startLine = thread.threadContext?.rightFileStart?.line;
        const startCol = thread.threadContext?.rightFileStart?.offset;
        const endLine = thread.threadContext?.rightFileEnd?.line;
        const endCol = thread.threadContext?.rightFileEnd?.offset;

        let location: string;
        if (startLine) {
            const lineRange = endLine && endLine !== startLine ? `L${startLine}-${endLine}` : `L${startLine}`;
            const colRange = startCol ? ` Col${startCol}${endCol && endCol !== startCol ? `-${endCol}` : ''}` : '';
            location = `${filePath} ${lineRange}${colRange}`;
        } else {
            location = filePath;
        }

        parts.push(`## Comment Thread`);
        parts.push(`**Location:** ${location}`);
        parts.push(`**Status:** ${statusName(thread.status)}`);
        parts.push('');

        const comments = (thread.comments ?? []).filter(
            c => !c.isDeleted && c.commentType !== CommentType.System,
        );
        for (const c of comments) {
            const author = c.author?.displayName ?? 'Unknown';
            const date = c.publishedDate ? new Date(c.publishedDate).toISOString().slice(0, 10) : '';
            parts.push(`**${author}** ${date ? `(${date})` : ''}:`);
            parts.push(c.content ?? '');
            parts.push('');
        }
        return parts.join('\n');
    }

    /**
     * Build a text summary of the active PR for inclusion in an LM prompt.
     */
    formatPrForPrompt(): string {
        const pr = this._activePr;
        if (!pr) { return 'No active pull request.'; }

        const source = pr.sourceRefName?.replace(/^refs\/heads\//, '') ?? '?';
        const target = pr.targetRefName?.replace(/^refs\/heads\//, '') ?? '?';
        const parts = [
            `## Pull Request #${pr.pullRequestId}: ${pr.title ?? '(untitled)'}`,
            `**Author:** ${pr.createdBy?.displayName ?? 'Unknown'}`,
            `**Branches:** ${source} → ${target}`,
        ];
        if (pr.description) {
            parts.push('', '**Description:**', pr.description);
        }
        if (this._changedFilePaths.length > 0) {
            parts.push('', '**Changed files:**');
            for (const f of this._changedFilePaths) {
                parts.push(`- ${f}`);
            }
        }
        return parts.join('\n');
    }
}

function statusName(status: number | undefined): string {
    switch (status) {
        case 1: return 'Active';
        case 2: return 'Fixed';
        case 3: return "Won't Fix";
        case 4: return 'Closed';
        case 5: return 'By Design';
        case 6: return 'Pending';
        default: return 'Unknown';
    }
}
