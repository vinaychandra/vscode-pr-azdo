import * as assert from 'assert';
import type { GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { PullRequestService } from '../../azdo/prService';

function createService(gitApi: object): PullRequestService {
    return new PullRequestService(
        { getGitApi: async () => gitApi } as any,
        {
            repositoryName: 'repo',
            project: 'project',
        } as any,
    );
}

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