import type { GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { PullRequestStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
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
}
