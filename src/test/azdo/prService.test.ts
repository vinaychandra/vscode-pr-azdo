import * as assert from 'assert';
import { Readable } from 'stream';
import JSZip = require('jszip');
import type { GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { GitVersionType, VersionControlChangeType, VersionControlRecursionType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { isAuthError } from '../../azdo/apiClient';
import { fileContentKey, PullRequestService } from '../../azdo/prService';

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

suite('PullRequestService - getPrThreads', () => {
    test('requests positions tracked to the selected iteration comparison, including Base', async () => {
        const calls: unknown[][] = [];
        const service = createService({
            getThreads: async (...args: unknown[]) => {
                calls.push(args);
                return [];
            },
        });
        await service.getPrThreads(42, 3, 2);
        await service.getPrThreads(42, 2, 0);
        await service.getPrThreads(42);
        assert.deepStrictEqual(calls, [
            ['repo', 42, 'project', 3, 2],
            ['repo', 42, 'project', 2, 0],
            ['repo', 42, 'project', undefined, undefined],
        ]);
    });
});

suite('PullRequestService - strict AI snapshot reads', () => {
    test('rejects unavailable files instead of returning success-shaped empty content', async () => {
        const service = createService({ getItemsBatch: async () => [[]] });
        await assert.rejects(service.getFileContents([{ path: 'missing.ts', commitId: 'source' }], true), /unavailable/);
        assert.strictEqual((await service.getFileContents([{ path: 'missing.ts', commitId: 'source' }])).get('source:missing.ts'), '');
    });

    test('rejects a missing downloaded blob', async () => {
        const zip = await new JSZip().generateAsync({ type: 'nodebuffer' });
        const service = createService({
            getItemsBatch: async () => [[{ objectId: 'missing-blob' }]],
            getBlobsZip: async () => Readable.from(zip),
        });
        await assert.rejects(service.getFileContents([{ path: 'app.ts', commitId: 'source' }], true), /unavailable/);
    });

    test('lists only directory children at the exact commit and configured repository', async () => {
        const calls: unknown[][] = [];
        const service = createService({
            getItems: async (...args: unknown[]) => {
                calls.push(args);
                return [
                    { path: '/src', isFolder: true },
                    { path: '/src/app.ts', isFolder: false },
                    { path: '/src/child', isFolder: true },
                ];
            },
        });
        assert.deepStrictEqual(await service.listFiles('source-sha', 'src'), [
            { path: 'src/app.ts', directory: false }, { path: 'src/child', directory: true },
        ]);
        assert.deepStrictEqual(calls, [[
            'repo', 'project', '/src', VersionControlRecursionType.OneLevel,
            false, false, false, false, { version: 'source-sha', versionType: GitVersionType.Commit },
        ]]);
    });
});

suite('PullRequestService — getFileContents', () => {
    test('resolves all path versions and downloads their blobs in two API calls', async () => {
        const zip = new JSZip();
        zip.file('blob-source', 'source content');
        zip.file('blob-base', 'base content');
        const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
        const itemBatchCalls: unknown[][] = [];
        const blobBatchCalls: unknown[][] = [];
        const service = createService({
            getItemsBatch: async (...args: unknown[]) => {
                itemBatchCalls.push(args);
                return [
                    [{ objectId: 'blob-source' }],
                    [{ objectId: 'blob-base' }],
                ];
            },
            getBlobsZip: async (...args: unknown[]) => {
                blobBatchCalls.push(args);
                return Readable.from(zipBuffer);
            },
        });

        const contents = await service.getFileContents([
            { path: 'src/app.ts', commitId: 'source-sha' },
            { path: 'src/app.ts', commitId: 'base-sha' },
        ]);

        assert.deepStrictEqual(itemBatchCalls, [[{
            itemDescriptors: [
                {
                    path: '/src/app.ts',
                    version: 'source-sha',
                    versionType: GitVersionType.Commit,
                    recursionLevel: VersionControlRecursionType.None,
                },
                {
                    path: '/src/app.ts',
                    version: 'base-sha',
                    versionType: GitVersionType.Commit,
                    recursionLevel: VersionControlRecursionType.None,
                },
            ],
        }, 'repo', 'project']]);
        assert.deepStrictEqual(blobBatchCalls, [[['blob-source', 'blob-base'], 'repo', 'project']]);
        assert.strictEqual(contents.get(fileContentKey('source-sha', 'src/app.ts')), 'source content');
        assert.strictEqual(contents.get(fileContentKey('base-sha', 'src/app.ts')), 'base content');
    });

    test('builds content for an arbitrary Azure iteration range', async () => {
        const zip = new JSZip();
        zip.file('head-blob', 'head content');
        zip.file('iteration-blob', 'iteration content');
        const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
        const changeCalls: unknown[][] = [];
        const service = createService({
            getPullRequestIterations: async () => [
                {
                    id: 1,
                    sourceRefCommit: { commitId: 'iteration-one' },
                    targetRefCommit: { commitId: 'target-one' },
                    commonRefCommit: { commitId: 'base-one' },
                },
                {
                    id: 2,
                    sourceRefCommit: { commitId: 'iteration-two' },
                    targetRefCommit: { commitId: 'target-two' },
                    commonRefCommit: { commitId: 'base-two' },
                },
                {
                    id: 3,
                    sourceRefCommit: { commitId: 'head-sha' },
                    targetRefCommit: { commitId: 'target-three' },
                    commonRefCommit: { commitId: 'base-three' },
                },
            ],
            getPullRequestIterationChanges: async (...args: unknown[]) => {
                changeCalls.push(args);
                return {
                    changeEntries: [{
                        changeType: VersionControlChangeType.Edit,
                        item: { path: '/src/app.ts' },
                    }],
                };
            },
            getItemsBatch: async () => [
                [{ objectId: 'head-blob' }],
                [{ objectId: 'iteration-blob' }],
            ],
            getBlobsZip: async () => Readable.from(zipBuffer),
        });

        const snapshot = await service.getApiReviewSnapshot(42, 2, 1);

        assert.strictEqual(snapshot.iterationId, 2);
        assert.strictEqual(snapshot.compareToIterationId, 1);
        assert.strictEqual(snapshot.sourceCommit, 'iteration-two');
        assert.strictEqual(snapshot.comparisonCommit, 'iteration-one');
        assert.deepStrictEqual(changeCalls, [['repo', 42, 2, 'project', undefined, undefined, 1]]);
        assert.strictEqual(snapshot.contents.get(fileContentKey('iteration-two', 'src/app.ts')), 'head content');
        assert.strictEqual(snapshot.contents.get(fileContentKey('iteration-one', 'src/app.ts')), 'iteration content');
    });

    test('uses the selected iteration common commit when compareTo is Base', async () => {
        const changeCalls: unknown[][] = [];
        const service = createService({
            getPullRequestIterations: async () => [{
                id: 1,
                sourceRefCommit: { commitId: 'iteration-one' },
                targetRefCommit: { commitId: 'target-at-one' },
                commonRefCommit: { commitId: 'common-at-one' },
            }],
            getPullRequestIterationChanges: async (...args: unknown[]) => {
                changeCalls.push(args);
                return { changeEntries: [] };
            },
        });

        const snapshot = await service.getApiReviewSnapshot(42, 1, 0);

        assert.strictEqual(snapshot.sourceCommit, 'iteration-one');
        assert.strictEqual(snapshot.comparisonCommit, 'common-at-one');
        assert.notStrictEqual(snapshot.comparisonCommit, snapshot.targetCommit);
        assert.deepStrictEqual(changeCalls, [['repo', 42, 1, 'project', undefined, undefined, 0]]);
    });
});

suite('PullRequestService — getPrIterationChanges', () => {
    test('combines paged changes while preserving compareTo', async () => {
        const calls: unknown[][] = [];
        const service = createService({
            getPullRequestIterationChanges: async (...args: unknown[]) => {
                calls.push(args);
                return calls.length === 1
                    ? { changeEntries: [{ changeId: 1 }], nextSkip: 100, nextTop: 100 }
                    : { changeEntries: [{ changeId: 2 }], nextSkip: 0, nextTop: 0 };
            },
        });

        const result = await service.getPrIterationChanges(42, 5, 2);

        assert.deepStrictEqual(result.changeEntries?.map(change => change.changeId), [1, 2]);
        assert.deepStrictEqual(calls, [
            ['repo', 42, 5, 'project', undefined, undefined, 2],
            ['repo', 42, 5, 'project', 100, 100, 2],
        ]);
    });
});

suite('PullRequestService — createThread', () => {
    test('includes selected iteration context and change tracking ID', async () => {
        let request: any;
        const service = createService({
            createThread: async (thread: unknown) => {
                request = thread;
                return thread;
            },
        });

        await service.createThread(
            42,
            'Review comment',
            { filePath: '/src/app.ts', startLine: 4, startCol: 1, endLine: 4, endCol: 5 },
            17,
            5,
            2,
        );

        assert.deepStrictEqual(request.pullRequestThreadContext, {
            changeTrackingId: 17,
            iterationContext: {
                firstComparingIteration: 2,
                secondComparingIteration: 5,
            },
        });
    });

    test('represents a Base comparison by using the selected iteration on both sides', async () => {
        let request: any;
        const service = createService({
            createThread: async (thread: unknown) => {
                request = thread;
                return thread;
            },
        });

        await service.createThread(
            42,
            'Base comparison comment',
            { filePath: '/src/app.ts', startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
            17,
            1,
            0,
        );

        assert.deepStrictEqual(request.pullRequestThreadContext.iterationContext, {
            firstComparingIteration: 1,
            secondComparingIteration: 1,
        });
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