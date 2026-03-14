import type { GitPullRequest, GitCommitRef, GitPullRequestIteration, GitPullRequestIterationChanges, GitPullRequestCommentThread, GitPullRequestChange } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { PullRequestStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { GitPullRequestSearchCriteria } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { AzDoApiClient } from './apiClient';
import type { AzDoRemoteInfo } from './remoteInfo';

const MAX_PAGE_SIZE = 100;
const MAX_ITEMS = 1000;

/**
 * Fetches pull request data from Azure DevOps.
 */
export class PullRequestService {
    constructor(
        private readonly apiClient: AzDoApiClient,
        private readonly remoteInfo: AzDoRemoteInfo,
    ) { }

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
}
