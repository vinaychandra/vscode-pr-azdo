import * as assert from 'assert';
import * as vscode from 'vscode';
import { AzDoApiClient } from '../../azdo/apiClient';
import { EntraIdAuthProvider } from '../../azdo/auth/entraIdAuthProvider';
import type { ParsedAzDoRemote } from '../../azdo/remoteInfo';
import type { DevelopmentReviewApi } from '../../extension';
import { buildGitRefUri } from '../../views/gitRefContentProvider';
import { LiveRepository, waitFor, type RestThread } from './liveRepository';

const remote: ParsedAzDoRemote = {
    organization: 'vinaychandra',
    project: 'Personal',
    repositoryName: 'E2ETestRepo',
    remoteName: 'live-test',
    remoteUrl: 'https://dev.azure.com/vinaychandra/Personal/_git/E2ETestRepo',
    apiBaseUrl: 'https://dev.azure.com/vinaychandra',
};

suite('Live review workflow', () => {
    let log: vscode.LogOutputChannel;
    let auth: EntraIdAuthProvider;
    let client: AzDoApiClient;
    let api: DevelopmentReviewApi;

    suiteSetup(async () => {
        assert.strictEqual(process.env.AZDO_LIVE_TESTS, '1', 'Use npm run test:live to opt in.');
        log = vscode.window.createOutputChannel('Azure DevOps live tests', { log: true });
        auth = new EntraIdAuthProvider(log);
        client = new AzDoApiClient(auth, remote, log);
        const extension = vscode.extensions.getExtension<DevelopmentReviewApi>('vinaydommeti.vscode-pr-azdo');
        assert.ok(extension);
        api = await extension.activate();
        assert.ok(api.commentController);
    });

    suiteTeardown(() => {
        client?.dispose();
        auth?.dispose();
        log?.dispose();
    });

    test('authenticates and verifies the dedicated test repository', async () => {
        const git = await client.getGitApi();
        const repository = await git.getRepository(remote.repositoryName, remote.project);
        assert.strictEqual(repository.name, remote.repositoryName);
        assert.strictEqual(repository.project?.name, remote.project);
        assert.ok(repository.id);
    });

    test('posts and tracks real comments through edits, historical iterations, deletion, and rename', async () => {
        await LiveRepository.recoverUnfinished(() => auth.getToken());
        const fixture = new LiveRepository(() => auth.getToken());
        let workflowFailure: unknown;
        try {
            await fixture.create();
            if (!api.commentController.reviewMode) {
                await vscode.commands.executeCommand('vscode-pr-azdo.toggleReviewMode');
            }
            await openReview(fixture, fixture.sourceCommit);
            const firstBody = `${fixture.runId}: original right-side comment`;
            const first = await postUserDraft(fixture, fixture.filePath, 'right', 3, firstBody, 1, 0);
            await assertRenderedMarker(first.id!, 'E2E_ANCHOR', fixture.sourceCommit);
            fixture.record('User draft posted and rendered on the original marker');

            await fixture.addShiftAndDeletion();
            await openReview(fixture, fixture.sourceCommit);
            await vscode.commands.executeCommand('vscode-pr-azdo.selectIteration', [1]);
            await synchronizeReview();
            const originalCommit = api.contextProvider.sourceRef!;
            assert.notStrictEqual(originalCommit, fixture.sourceCommit);
            const aiBody = `${fixture.runId}: AI draft on historical iteration`;
            const runId = await api.copilotReview.start();
            const createDraft = api.commentController.createDraftThread.bind(api.commentController);
            let draft: vscode.CommentThread | undefined;
            api.commentController.createDraftThread = (...args) => {
                const created = createDraft(...args);
                if (args[2] === aiBody) { draft = created; }
                return created;
            };
            try {
                const finding = { path: fixture.filePath.slice(1), line: 3, body: aiBody, type: 'issue' as const };
                assert.deepStrictEqual(
                    await api.copilotReview.createDrafts(runId, [finding], new vscode.CancellationTokenSource().token),
                    { created: 1, alreadyCreated: 0, published: false },
                );
                assert.deepStrictEqual(
                    await api.copilotReview.createDrafts(runId, [finding], new vscode.CancellationTokenSource().token),
                    { created: 0, alreadyCreated: 1, published: false },
                );
            } finally {
                api.commentController.createDraftThread = createDraft;
            }
            assert.ok(draft);
            await vscode.commands.executeCommand('vscode-pr-azdo.postDraft', draft);
            const historical = await fixture.findThread(aiBody, 1, 0);
            assertIteration(historical, 1, 0);
            assert.strictEqual(historical.threadContext?.rightFileStart?.line, 3);
            fixture.record('Structured Copilot findings are deduplicated and publish with historical iteration metadata');

            await vscode.commands.executeCommand('vscode-pr-azdo.selectIteration', [2]);
            await synchronizeReview();
            const second = await postUserDraft(fixture, fixture.filePath, 'right', 5, `${fixture.runId}: shifted marker`, 2, 1);
            await assertRenderedMarker(second.id!, 'E2E_ANCHOR', fixture.sourceCommit);
            const deleted = await postUserDraft(fixture, fixture.deletedPath, 'left', 1, `${fixture.runId}: deleted marker`, 2, 1);
            await assertRenderedMarker(deleted.id!, 'E2E_LEFT_ANCHOR', api.contextProvider.targetRef!);
            fixture.record('Iteration-to-iteration comments keep shifted and deleted-file markers');

            await fixture.addRename();
            await openReview(fixture, fixture.sourceCommit);
            const renamed = await fixture.findThread(firstBody, 3, 0);
            const changes = await fixture.request<{ changeEntries: { changeType: string; originalPath?: string; item?: { path?: string } }[] }>('GET', `pullrequests/${fixture.pullRequestId}/iterations/3/changes`, undefined, { '$compareTo': '0' });
            assert.ok(changes.changeEntries.some(change => change.changeType.toLowerCase().includes('rename') && change.originalPath === fixture.filePath && change.item?.path === fixture.renamedPath), 'Azure DevOps must recognize the fixture as a rename rather than delete/add.');
            assert.strictEqual(renamed.threadContext?.filePath, fixture.renamedPath, JSON.stringify({
                threadContext: renamed.threadContext,
                pullRequestThreadContext: renamed.pullRequestThreadContext,
                changes: changes.changeEntries,
            }, null, 2));
            assert.strictEqual(renamed.threadContext?.rightFileStart?.line, 5);
            await assertRenderedMarker(first.id!, 'E2E_ANCHOR', fixture.sourceCommit);
            const rendered = api.commentController.findThreadByAzdoId(first.id!)!;
            const original = api.commentController.getOriginalContext(rendered)!;
            assert.strictEqual(original.filePath, fixture.filePath.slice(1));
            assert.strictEqual(original.startLine, 3);
            assert.strictEqual(api.contextProvider.resolveCommentCommit(renamed as any), originalCommit);
            fixture.record('Server tracking and original context survive a file rename');

            const replyBody = `${fixture.runId}: reply`;
            await api.commentController.handleReply({ thread: rendered, text: replyBody });
            const replied = await fixture.findThread(replyBody, 3, 0);
            assert.strictEqual(replied.id, first.id);
            await vscode.commands.executeCommand('vscode-pr-azdo.resolveThread', rendered);
            await waitFor('resolved thread status through HTTP', () => fixture.findThread(firstBody, 3, 0), thread => thread.status === 'fixed');
            fixture.record('Reply and resolve actions persist through Azure DevOps HTTP');
        } catch (error) {
            workflowFailure = error;
        } finally {
            try {
                await vscode.commands.executeCommand('vscode-pr-azdo.stopReview');
            } catch (error) {
                workflowFailure ??= error;
            }
            try {
                await fixture.cleanup();
            } catch (error) {
                if (workflowFailure) { throw new AggregateError([workflowFailure, error], 'Workflow and cleanup failed. Inspect the live run ledger.'); }
                throw error;
            }
        }
        if (workflowFailure) { throw workflowFailure; }
    });

    async function synchronizeReview(): Promise<void> {
        const provider = api.activePrProvider;
        assert.ok(provider);
        const root = (await provider.getChildren()).find(item => item.contextValue === 'activePr');
        assert.ok(root);
        await provider.getChildren(root);
        await provider.refreshThreadsOnly();
        await waitFor('extension snapshot context', async () => api.contextProvider.sourceRef, source => source === provider.reviewContext?.sourceRef);
    }

    async function openReview(fixture: LiveRepository, commit: string): Promise<void> {
        await vscode.commands.executeCommand('vscode-pr-azdo.reviewPullRequestFromUrl', fixture.url);
        await synchronizeReview();
        assert.strictEqual(api.contextProvider.activePr?.pullRequestId, fixture.pullRequestId);
        assert.strictEqual(api.contextProvider.sourceRef, commit);
    }

    async function postUserDraft(fixture: LiveRepository, path: string, side: 'left' | 'right', line: number, body: string, iteration: number, base: number): Promise<RestThread> {
        const ref = side === 'left' ? api.contextProvider.targetRef : api.contextProvider.sourceRef;
        assert.ok(ref);
        const uri = buildGitRefUri(path.slice(1), ref);
        const draft = api.commentController.createUserDraftThread(uri, new vscode.Range(line - 1, 0, line - 1, 1), body);
        await vscode.commands.executeCommand('vscode-pr-azdo.postUserDraft', draft);
        const posted = await fixture.findThread(body, iteration, base);
        assert.strictEqual(posted.threadContext?.filePath, path);
        assert.strictEqual(side === 'left' ? posted.threadContext?.leftFileStart?.line : posted.threadContext?.rightFileStart?.line, line);
        assertIteration(posted, iteration, base);
        await synchronizeReview();
        return posted;
    }

    function assertIteration(thread: RestThread, iteration: number, base: number): void {
        assert.strictEqual(thread.pullRequestThreadContext?.iterationContext?.secondComparingIteration, iteration, 'Posted comments must belong to the reviewed source iteration.');
        assert.strictEqual(thread.pullRequestThreadContext?.iterationContext?.firstComparingIteration, base || iteration, 'Posted comments must use the reviewed base iteration.');
    }

    async function assertRenderedMarker(threadId: number, marker: string, ref: string): Promise<void> {
        const thread = await waitFor('inline thread rendering', async () => api.commentController.findThreadByAzdoId(threadId), value => !!value);
        assert.ok(thread?.range);
        assert.strictEqual(new URLSearchParams(thread.uri.query).get('ref'), ref);
        const document = await vscode.workspace.openTextDocument(thread.uri);
        assert.ok(document.lineAt(thread.range.start.line).text.includes(marker), `Comment ${threadId} does not point to ${marker}.`);
    }
});