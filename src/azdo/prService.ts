import type { GitPullRequest, GitCommitRef, GitPullRequestIteration, GitPullRequestIterationChanges, GitPullRequestCommentThread, Comment as AzDoComment } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { PullRequestStatus, CommentThreadStatus, CommentType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { AzDoApiClient } from './apiClient';
import type { AzDoRemoteInfo } from './remoteInfo';

/**
 * Fetches pull request data from Azure DevOps.
 */
export class PullRequestService {
    constructor(
        private readonly apiClient: AzDoApiClient,
        private readonly remoteInfo: AzDoRemoteInfo,
    ) { }

    /** Whether the underlying API client has an active authenticated connection. */
    get isConnected(): boolean {
        return this.apiClient.isConnected;
    }
    /** All active pull requests in the repository. */
    async getOpenPullRequests(): Promise<GitPullRequest[]> {
        const git = await this.apiClient.getGitApi();
        return git.getPullRequests(
            this.remoteInfo.repositoryName,
            { status: PullRequestStatus.Active },
            this.remoteInfo.project,
        );
    }

    /** Active pull requests created by the given user. */
    async getMyPullRequests(userId: string): Promise<GitPullRequest[]> {
        const git = await this.apiClient.getGitApi();
        return git.getPullRequests(
            this.remoteInfo.repositoryName,
            { status: PullRequestStatus.Active, creatorId: userId },
            this.remoteInfo.project,
        );
    }

    /** Active pull requests where the given user is a reviewer. */
    async getPullRequestsAwaitingMyReview(userId: string): Promise<GitPullRequest[]> {
        const git = await this.apiClient.getGitApi();
        return git.getPullRequests(
            this.remoteInfo.repositoryName,
            { status: PullRequestStatus.Active, reviewerId: userId },
            this.remoteInfo.project,
        );
    }

    /**
     * Find an active PR whose source branch matches the given branch name.
     * @param branchName Short branch name (e.g. "feature/fix"), not "refs/heads/...".
     */
    async findPrForBranch(branchName: string): Promise<GitPullRequest | undefined> {
        const git = await this.apiClient.getGitApi();
        const prs = await git.getPullRequests(
            this.remoteInfo.repositoryName,
            {
                status: PullRequestStatus.Active,
                sourceRefName: `refs/heads/${branchName}`,
            },
            this.remoteInfo.project,
            undefined,
            undefined,
            1, // top — we only need the first match
        );
        return prs[0];
    }

    /** Get all iterations for a pull request. */
    async getPrIterations(pullRequestId: number): Promise<GitPullRequestIteration[]> {
        const git = await this.apiClient.getGitApi();
        return git.getPullRequestIterations(
            this.remoteInfo.repositoryName,
            pullRequestId,
            this.remoteInfo.project,
        );
    }

    /** Get file changes for a specific iteration of a pull request. */
    async getPrIterationChanges(pullRequestId: number, iterationId: number): Promise<GitPullRequestIterationChanges> {
        const git = await this.apiClient.getGitApi();
        return git.getPullRequestIterationChanges(
            this.remoteInfo.repositoryName,
            pullRequestId,
            iterationId,
            this.remoteInfo.project,
        );
    }

    /** Get commits for a pull request. */
    async getPrCommits(pullRequestId: number): Promise<GitCommitRef[]> {
        const git = await this.apiClient.getGitApi();
        return git.getPullRequestCommits(
            this.remoteInfo.repositoryName,
            pullRequestId,
            this.remoteInfo.project,
        );
    }

    /** Get all comment threads for a pull request. */
    async getPrThreads(pullRequestId: number): Promise<GitPullRequestCommentThread[]> {
        const git = await this.apiClient.getGitApi();
        return git.getThreads(
            this.remoteInfo.repositoryName,
            pullRequestId,
            this.remoteInfo.project,
        );
    }

    /** Create a reply comment on an existing thread. */
    async createComment(pullRequestId: number, threadId: number, content: string): Promise<AzDoComment> {
        const git = await this.apiClient.getGitApi();
        return git.createComment(
            { content, commentType: CommentType.Text },
            this.remoteInfo.repositoryName,
            pullRequestId,
            threadId,
            this.remoteInfo.project,
        );
    }

    /** Create a new comment thread on a file (or PR-level if no threadContext). */
    async createThread(
        pullRequestId: number,
        content: string,
        threadContext?: { filePath: string; startLine: number; startCol: number; endLine: number; endCol: number },
    ): Promise<GitPullRequestCommentThread> {
        const git = await this.apiClient.getGitApi();
        const thread: GitPullRequestCommentThread = {
            comments: [{ content, commentType: CommentType.Text }],
            status: CommentThreadStatus.Active,
        };
        if (threadContext) {
            thread.threadContext = {
                filePath: threadContext.filePath,
                rightFileStart: { line: threadContext.startLine, offset: threadContext.startCol },
                rightFileEnd: { line: threadContext.endLine, offset: threadContext.endCol },
            };
        }
        return git.createThread(
            thread,
            this.remoteInfo.repositoryName,
            pullRequestId,
            this.remoteInfo.project,
        );
    }

    /** Update a thread's status (Active, Fixed, WontFix, Closed, etc.). */
    async updateThreadStatus(pullRequestId: number, threadId: number, status: CommentThreadStatus): Promise<GitPullRequestCommentThread> {
        const git = await this.apiClient.getGitApi();
        return git.updateThread(
            { status },
            this.remoteInfo.repositoryName,
            pullRequestId,
            threadId,
            this.remoteInfo.project,
        );
    }

    /** Delete a comment from a thread. */
    async deleteComment(pullRequestId: number, threadId: number, commentId: number): Promise<void> {
        const git = await this.apiClient.getGitApi();
        return git.deleteComment(
            this.remoteInfo.repositoryName,
            pullRequestId,
            threadId,
            commentId,
            this.remoteInfo.project,
        );
    }

    /** Create a new pull request. Returns the created PR. */
    async createPullRequest(
        sourceBranch: string,
        targetBranch: string,
        title: string,
        description?: string,
        isDraft?: boolean,
    ): Promise<GitPullRequest> {
        const git = await this.apiClient.getGitApi();
        return git.createPullRequest(
            {
                sourceRefName: `refs/heads/${sourceBranch}`,
                targetRefName: `refs/heads/${targetBranch}`,
                title,
                description: description ?? '',
                isDraft: isDraft ?? false,
            },
            this.remoteInfo.repositoryName,
            this.remoteInfo.project,
        );
    }
}
