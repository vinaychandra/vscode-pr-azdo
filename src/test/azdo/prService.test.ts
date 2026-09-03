import * as assert from 'assert';
import type { GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { isAuthError } from '../../azdo/apiClient';
import { PullRequestService } from '../../azdo/prService';

function createService(gitApi: object): PullRequestService {
    return new PullRequestService(
        {
            getGitApi: async () => gitApi,
            withAuthRecovery: async (operation: () => Promise<unknown>) => operation(),
        } as any,
        {
            repositoryName: 'repo',
            project: 'project',
        } as any,
    );
}

suite('PullRequestService — getPullRequest', () => {
    test('fetches one PR from the configured repository and project', async () => {
        const expected = { pullRequestId: 42 } as GitPullRequest;
        const calls: unknown[][] = [];
        const service = createService({
            getPullRequest: async (...args: unknown[]) => {
                calls.push(args);
                return expected;
            },
        });

        assert.strictEqual(await service.getPullRequest(42), expected);
        assert.deepStrictEqual(calls, [['repo', 42, 'project']]);
    });
});

suite('PullRequestService — findPrForCommit', () => {
    test('matches the active PR source tip without fetching commit lists', async () => {
        const expected = {
            pullRequestId: 42,
            lastMergeSourceCommit: { commitId: 'ABC123' },
        } as GitPullRequest;
        let commitListCalls = 0;
        const service = createService({
            getPullRequests: async () => [expected],
            getPullRequestCommits: async () => {
                commitListCalls++;
                return [];
            },
        });

        const result = await service.findPrForCommit('abc123');

        assert.strictEqual(result, expected);
        assert.strictEqual(commitListCalls, 0);
    });

    test('matches a commit contained in an active PR', async () => {
        const first = { pullRequestId: 1 } as GitPullRequest;
        const expected = { pullRequestId: 2 } as GitPullRequest;
        const fetchedPrIds: number[] = [];
        const service = createService({
            getPullRequests: async () => [first, expected],
            getPullRequestCommits: async (_repo: string, pullRequestId: number) => {
                fetchedPrIds.push(pullRequestId);
                return pullRequestId === 2 ? [{ commitId: 'DEF456' }] : [{ commitId: 'other' }];
            },
        });

        const result = await service.findPrForCommit('def456');

        assert.strictEqual(result, expected);
        assert.deepStrictEqual(fetchedPrIds, [1, 2]);
    });

    test('returns undefined when no active PR contains the commit', async () => {
        const service = createService({
            getPullRequests: async () => [{ pullRequestId: 1 }],
            getPullRequestCommits: async () => [{ commitId: 'other' }],
        });

        const result = await service.findPrForCommit('missing');

        assert.strictEqual(result, undefined);
    });
});

suite('PullRequestService — auth recovery', () => {
    test('reacquires the Git API client when retrying an operation', async () => {
        const expected = { pullRequestId: 42 } as GitPullRequest;
        let gitApiCalls = 0;
        let operationCalls = 0;
        const apiClient = {
            getGitApi: async () => {
                gitApiCalls++;
                return {
                    getPullRequests: async () => {
                        operationCalls++;
                        if (operationCalls === 1) {
                            throw new Error('HTTP 401 Unauthorized');
                        }
                        return [expected];
                    },
                };
            },
            withAuthRecovery: async (operation: () => Promise<unknown>) => {
                try {
                    return await operation();
                } catch (err) {
                    if (!isAuthError(err)) { throw err; }
                    return operation();
                }
            },
        };
        const service = new PullRequestService(apiClient as any, {
            repositoryName: 'repo',
            project: 'project',
        } as any);

        const result = await service.getOpenPullRequests();

        assert.deepStrictEqual(result, [expected]);
        assert.strictEqual(gitApiCalls, 2);
        assert.strictEqual(operationCalls, 2);
    });
});