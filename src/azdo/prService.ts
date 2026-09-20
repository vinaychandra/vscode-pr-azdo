import JSZip = require('jszip');
import type { GitPullRequest, GitCommitRef, GitPullRequestChange, GitPullRequestIteration, GitPullRequestIterationChanges, GitPullRequestCommentThread, Comment as AzDoComment } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { PullRequestStatus, CommentThreadStatus, CommentType, GitVersionType, VersionControlChangeType, VersionControlRecursionType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { IGitApi } from 'azure-devops-node-api/GitApi';
import type { AzDoApiClient } from './apiClient';
import type { ParsedAzDoRemote } from './remoteInfo';

export interface FileContentRequest {
    path: string;
    commitId: string;
}

export interface ApiPullRequestSnapshot {
    iterations: GitPullRequestIteration[];
    headIterationId: number;
    compareToIterationId?: number;
    sourceCommit: string;
    targetCommit: string;
    comparisonCommit: string;
    changes: GitPullRequestChange[];
    contents: ReadonlyMap<string, string>;
}

export function fileContentKey(commitId: string, filePath: string): string {
    return `${commitId}:${filePath.replace(/^\//, '')}`;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

/**
 * Fetches pull request data from Azure DevOps.
 */
export class PullRequestService {
    constructor(
        private readonly apiClient: AzDoApiClient,
        private readonly remoteInfo: ParsedAzDoRemote,
    ) { }

    /** Whether the underlying API client has an active authenticated connection. */
    get isConnected(): boolean {
        return this.apiClient.isConnected;
    }

    private withGitApi<T>(operation: (git: IGitApi) => Promise<T>): Promise<T> {
        return this.apiClient.withAuthRecovery(async () => operation(await this.apiClient.getGitApi()));
    }

    /** All active pull requests in the repository. */
    async getOpenPullRequests(): Promise<GitPullRequest[]> {
        return this.withGitApi(git => git.getPullRequests(
            this.remoteInfo.repositoryName,
            { status: PullRequestStatus.Active },
            this.remoteInfo.project,
        ));
    }

    /** Get one pull request by repository-scoped ID. */
    async getPullRequest(pullRequestId: number): Promise<GitPullRequest> {
        return this.withGitApi(git => git.getPullRequest(
            this.remoteInfo.repositoryName,
            pullRequestId,
            this.remoteInfo.project,
        ));
    }

    /** Resolve many file versions at once, then download all unique blobs in one ZIP response. */
    async getFileContents(requests: readonly FileContentRequest[]): Promise<Map<string, string>> {
        if (requests.length === 0) {
            return new Map();
        }

        return this.withGitApi(async git => {
            const uniqueRequests = [...new Map(requests.map(request => [
                fileContentKey(request.commitId, request.path),
                request,
            ])).values()];
            const itemGroups = await git.getItemsBatch({
                itemDescriptors: uniqueRequests.map(request => ({
                    path: `/${request.path.replace(/^\//, '')}`,
                    version: request.commitId,
                    versionType: GitVersionType.Commit,
                    recursionLevel: VersionControlRecursionType.None,
                })),
            }, this.remoteInfo.repositoryName, this.remoteInfo.project);

            const objectIds = [...new Set(itemGroups
                .map(items => items[0]?.objectId)
                .filter((objectId): objectId is string => !!objectId))];
            const contentByObjectId = new Map<string, string>();
            if (objectIds.length > 0) {
                const archive = await streamToBuffer(await git.getBlobsZip(
                    objectIds,
                    this.remoteInfo.repositoryName,
                    this.remoteInfo.project,
                ));
                const zip = await JSZip.loadAsync(archive);
                const entries = Object.values(zip.files).filter(entry => !entry.dir);
                for (const [index, objectId] of objectIds.entries()) {
                    const normalizedId = objectId.toLowerCase();
                    const entry = entries.find(candidate => {
                        const fileName = candidate.name.split('/').pop()?.toLowerCase();
                        return fileName === normalizedId || candidate.name.toLowerCase().includes(normalizedId);
                    }) ?? (entries.length === objectIds.length ? entries[index] : undefined);
                    if (entry) {
                        contentByObjectId.set(objectId, await entry.async('string'));
                    }
                }
            }

            const result = new Map<string, string>();
            uniqueRequests.forEach((request, index) => {
                const objectId = itemGroups[index]?.[0]?.objectId;
                result.set(
                    fileContentKey(request.commitId, request.path),
                    objectId ? contentByObjectId.get(objectId) ?? '' : '',
                );
            });
            return result;
        });
    }

    /** Active pull requests created by the given user. */
    async getMyPullRequests(userId: string): Promise<GitPullRequest[]> {
        return this.withGitApi(git => git.getPullRequests(
            this.remoteInfo.repositoryName,
            { status: PullRequestStatus.Active, creatorId: userId },
            this.remoteInfo.project,
        ));
    }

    /** Active pull requests where the given user is a reviewer. */
    async getPullRequestsAwaitingMyReview(userId: string): Promise<GitPullRequest[]> {
        return this.withGitApi(git => git.getPullRequests(
            this.remoteInfo.repositoryName,
            { status: PullRequestStatus.Active, reviewerId: userId },
            this.remoteInfo.project,
        ));
    }

    /**
     * Find an active PR whose source branch matches the given branch name.
     * @param branchName Short branch name (e.g. "feature/fix"), not "refs/heads/...".
     */
    async findPrForBranch(branchName: string): Promise<GitPullRequest | undefined> {
        return this.withGitApi(async git => {
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
        });
    }

    /** Find an active PR that contains the given commit. */
    async findPrForCommit(commitId: string): Promise<GitPullRequest | undefined> {
        return this.withGitApi(async git => {
            const prs = await git.getPullRequests(
                this.remoteInfo.repositoryName,
                { status: PullRequestStatus.Active },
                this.remoteInfo.project,
            );
            const normalizedCommitId = commitId.toLowerCase();

            const sourceTipMatch = prs.find(pr =>
                pr.lastMergeSourceCommit?.commitId?.toLowerCase() === normalizedCommitId,
            );
            if (sourceTipMatch) {
                return sourceTipMatch;
            }

            for (const pr of prs) {
                if (pr.pullRequestId === undefined) {
                    continue;
                }
                const commits = pr.commits ?? await git.getPullRequestCommits(
                    this.remoteInfo.repositoryName,
                    pr.pullRequestId,
                    this.remoteInfo.project,
                );
                if (commits.some(commit => commit.commitId?.toLowerCase() === normalizedCommitId)) {
                    return pr;
                }
            }
            return undefined;
        });
    }

    /** Get all iterations for a pull request. */
    async getPrIterations(pullRequestId: number): Promise<GitPullRequestIteration[]> {
        return this.withGitApi(git => git.getPullRequestIterations(
            this.remoteInfo.repositoryName,
            pullRequestId,
            this.remoteInfo.project,
        ));
    }

    /** Get file changes for a specific iteration of a pull request. */
    async getPrIterationChanges(pullRequestId: number, iterationId: number, compareTo?: number): Promise<GitPullRequestIterationChanges> {
        return this.withGitApi(async git => {
            const changeEntries: GitPullRequestChange[] = [];
            let skip: number | undefined;
            let nextTop: number | undefined;
            do {
                const page = await git.getPullRequestIterationChanges(
                    this.remoteInfo.repositoryName,
                    pullRequestId,
                    iterationId,
                    this.remoteInfo.project,
                    nextTop,
                    skip,
                    compareTo,
                );
                changeEntries.push(...(page.changeEntries ?? []));
                skip = page.nextSkip && page.nextSkip > 0 ? page.nextSkip : undefined;
                nextTop = page.nextTop && page.nextTop > 0 ? page.nextTop : undefined;
            } while (skip !== undefined);
            return { changeEntries };
        });
    }

    /** Build immutable content for the latest PR head against its merge base or a selected iteration. */
    async getApiReviewSnapshot(pullRequestId: number, compareToIterationId?: number): Promise<ApiPullRequestSnapshot> {
        const iterations = await this.getPrIterations(pullRequestId);
        const head = iterations[iterations.length - 1];
        const headIterationId = head?.id;
        const sourceCommit = head?.sourceRefCommit?.commitId;
        const targetCommit = head?.targetRefCommit?.commitId;
        const selectedIteration = compareToIterationId === undefined
            ? undefined
            : iterations.find(iteration => iteration.id === compareToIterationId);
        const comparisonCommit = selectedIteration?.sourceRefCommit?.commitId
            ?? head?.commonRefCommit?.commitId;
        if (!headIterationId || !sourceCommit || !targetCommit || !comparisonCommit) {
            throw new Error('Azure DevOps did not return complete commit information for the pull request iterations.');
        }
        if (compareToIterationId !== undefined && !selectedIteration) {
            throw new Error(`Pull request iteration ${compareToIterationId} was not found.`);
        }

        const changeResult = await this.getPrIterationChanges(pullRequestId, headIterationId, compareToIterationId);
        const changes = (changeResult.changeEntries ?? []) as GitPullRequestChange[];
        const requests: FileContentRequest[] = [];
        for (const change of changes) {
            const changeType = (change as { changeType?: number }).changeType ?? 0;
            const sourcePath = change.item?.path?.replace(/^\//, '');
            const comparisonPath = ((change as { originalPath?: string }).originalPath ?? change.item?.path)?.replace(/^\//, '');
            if (sourcePath && !(changeType & VersionControlChangeType.Delete)) {
                requests.push({ path: sourcePath, commitId: sourceCommit });
            }
            if (comparisonPath && !(changeType & VersionControlChangeType.Add)) {
                requests.push({ path: comparisonPath, commitId: comparisonCommit });
            }
        }
        const downloadedContents = await this.getFileContents(requests);
        const contents = new Map(downloadedContents);
        for (const change of changes) {
            const currentPath = change.item?.path?.replace(/^\//, '');
            const originalPath = (change as { originalPath?: string }).originalPath?.replace(/^\//, '');
            if (currentPath && originalPath && currentPath !== originalPath) {
                const originalContent = downloadedContents.get(fileContentKey(comparisonCommit, originalPath));
                if (originalContent !== undefined) {
                    contents.set(fileContentKey(comparisonCommit, currentPath), originalContent);
                }
            }
        }

        return {
            iterations,
            headIterationId,
            compareToIterationId,
            sourceCommit,
            targetCommit,
            comparisonCommit,
            changes,
            contents,
        };
    }

    /** Get commits for a pull request. */
    async getPrCommits(pullRequestId: number): Promise<GitCommitRef[]> {
        return this.withGitApi(git => git.getPullRequestCommits(
            this.remoteInfo.repositoryName,
            pullRequestId,
            this.remoteInfo.project,
        ));
    }

    /** Get all comment threads for a pull request. */
    async getPrThreads(pullRequestId: number): Promise<GitPullRequestCommentThread[]> {
        return this.withGitApi(git => git.getThreads(
            this.remoteInfo.repositoryName,
            pullRequestId,
            this.remoteInfo.project,
        ));
    }

    /** Create a reply comment on an existing thread. */
    async createComment(pullRequestId: number, threadId: number, content: string): Promise<AzDoComment> {
        return this.withGitApi(git => git.createComment(
            { content, commentType: CommentType.Text },
            this.remoteInfo.repositoryName,
            pullRequestId,
            threadId,
            this.remoteInfo.project,
        ));
    }

    /**
     * Create a new comment thread on a file (or PR-level if no threadContext).
     *
     * @param threadContext.side  Which side of the diff the comment is anchored to.
     *                            'right' (default) for added/edited content,
     *                            'left' for content that exists only on the target
     *                            branch (e.g. deleted files or removed lines).
     */
    async createThread(
        pullRequestId: number,
        content: string,
        threadContext?: { filePath: string; startLine: number; startCol: number; endLine: number; endCol: number; side?: 'left' | 'right' },
    ): Promise<GitPullRequestCommentThread> {
        const thread: GitPullRequestCommentThread = {
            comments: [{ content, commentType: CommentType.Text }],
            status: CommentThreadStatus.Active,
        };
        if (threadContext) {
            const position = {
                start: { line: threadContext.startLine, offset: threadContext.startCol },
                end: { line: threadContext.endLine, offset: threadContext.endCol },
            };
            thread.threadContext = {
                filePath: threadContext.filePath,
                ...(threadContext.side === 'left'
                    ? { leftFileStart: position.start, leftFileEnd: position.end }
                    : { rightFileStart: position.start, rightFileEnd: position.end }),
            };
        }
        return this.withGitApi(git => git.createThread(
            thread,
            this.remoteInfo.repositoryName,
            pullRequestId,
            this.remoteInfo.project,
        ));
    }

    /** Update a thread's status (Active, Fixed, WontFix, Closed, etc.). */
    async updateThreadStatus(pullRequestId: number, threadId: number, status: CommentThreadStatus): Promise<GitPullRequestCommentThread> {
        return this.withGitApi(git => git.updateThread(
            { status },
            this.remoteInfo.repositoryName,
            pullRequestId,
            threadId,
            this.remoteInfo.project,
        ));
    }

    /** Delete a comment from a thread. */
    async deleteComment(pullRequestId: number, threadId: number, commentId: number): Promise<void> {
        return this.withGitApi(git => git.deleteComment(
            this.remoteInfo.repositoryName,
            pullRequestId,
            threadId,
            commentId,
            this.remoteInfo.project,
        ));
    }

    /** Create a new pull request. Returns the created PR. */
    async createPullRequest(
        sourceBranch: string,
        targetBranch: string,
        title: string,
        description?: string,
        isDraft?: boolean,
    ): Promise<GitPullRequest> {
        return this.withGitApi(git => git.createPullRequest(
            {
                sourceRefName: `refs/heads/${sourceBranch}`,
                targetRefName: `refs/heads/${targetBranch}`,
                title,
                description: description ?? '',
                isDraft: isDraft ?? false,
            },
            this.remoteInfo.repositoryName,
            this.remoteInfo.project,
        ));
    }
}
