import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommentType, VersionControlChangeType, type GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import {
    CopilotReviewService, COPILOT_REVIEW_AGENT, COPILOT_REVIEW_TOOL_IDS, COPILOT_SESSION_COMMAND,
    openCopilotReview, type CopilotReviewDependencies, type ReviewFinding,
} from '../../chat/copilotReview';
import { type ReviewTarget } from '../../chat/reviewContent';
import { buildReviewPrompt, BUILT_IN_REVIEW_LENSES, getBuiltInReviewLens } from '../../chat/reviewLenses';
import { fileContentKey } from '../../azdo/prService';
import { PrCommentController } from '../../views/prCommentController';

const token = new vscode.CancellationTokenSource().token;

suite('Copilot review launch', () => {
    test('opens an explicit Copilot session with the restricted agent and structured tools', async () => {
        const calls: { command: string; args: unknown[] }[] = [];
        await openCopilotReview('run-42', {
            getCommands: async () => [COPILOT_SESSION_COMMAND, 'workbench.action.chat.newLocalChat'],
            executeCommand: async <T>(command: string, ...args: unknown[]) => {
                calls.push({ command, args });
                return (command === COPILOT_SESSION_COMMAND ? vscode.Uri.parse('agent-host-copilotcli:/untitled-42') : undefined) as T;
            },
        });
        assert.deepStrictEqual(calls.map(call => call.command), [
            'workbench.action.chat.open', COPILOT_SESSION_COMMAND, 'workbench.action.chat.open',
        ]);
        assert.deepStrictEqual(calls[2].args, [{
            query: 'Perform Azure DevOps review run run-42. First call azdoReviewContext with runId "run-42" and follow its instructions. Use the review tools to create editable local drafts and fix previews; never post to Azure DevOps or edit workspace files.',
            mode: COPILOT_REVIEW_AGENT, toolIds: COPILOT_REVIEW_TOOL_IDS,
        }]);
        assert.ok(!JSON.stringify(calls).includes('@azdo-pr'));
    });

    test('does not fall back to Local or submit a query when Copilot is unavailable', async () => {
        const calls: string[] = [];
        await assert.rejects(openCopilotReview('run', {
            getCommands: async () => ['workbench.action.chat.newLocalChat'],
            executeCommand: async <T>(command: string) => { calls.push(command); return undefined as T; },
        }), /Copilot harness is unavailable/);
        assert.deepStrictEqual(calls, ['workbench.action.chat.open']);
    });

    test('does not send the review when session creation fails or returns the wrong harness', async () => {
        for (const scheme of [undefined, 'local', 'agent-host-claude']) {
            const calls: string[] = [];
            await assert.rejects(openCopilotReview('run', {
                getCommands: async () => [COPILOT_SESSION_COMMAND],
                executeCommand: async <T>(command: string) => {
                    calls.push(command);
                    return (scheme ? vscode.Uri.from({ scheme, path: '/session' }) : undefined) as T;
                },
            }), /No review was submitted/);
            assert.deepStrictEqual(calls, ['workbench.action.chat.open', COPILOT_SESSION_COMMAND]);
        }
    });
});

suite('Copilot review runs and native comments', () => {
    const disposables: vscode.Disposable[] = [];
    const temporaryDirectories: string[] = [];

    teardown(async () => {
        for (const disposable of disposables.splice(0)) { disposable.dispose(); }
        for (const directory of temporaryDirectories.splice(0)) { await fs.rm(directory, { recursive: true, force: true }); }
    });

    function fixture(overrides: Partial<ReviewTarget> = {}) {
        const log: vscode.OutputChannel = {
            name: 'Copilot review test', append: () => { }, appendLine: () => { }, replace: () => { },
            clear: () => { }, show: () => { }, hide: () => { }, dispose: () => { },
        };
        const comments = new PrCommentController(log);
        const contents = new Map([
            [fileContentKey('base', 'src/app.ts'), 'const value = 0;\nexport { value };\n'],
            [fileContentKey('source', 'src/app.ts'), 'const value = input;\nexport { value };\n'],
            [fileContentKey('source', '.github/copilot-instructions.md'), 'Check error handling.\n'],
            [fileContentKey('historical', 'old/app.ts'), 'old targeted code\n'],
        ]);
        let target: ReviewTarget = {
            identity: 'org/project/repo/42:base:source:2:1',
            pr: { pullRequestId: 42, title: 'Validate input', repository: { id: 'repo' } },
            snapshot: true, checkoutBacked: false, sourceRef: 'source', targetRef: 'base',
            iterationId: 2, compareToIterationId: 1,
            filePaths: ['src/app.ts'],
            changeTypes: new Map([['src/app.ts', VersionControlChangeType.Edit]]),
            contents,
            service: {
                getFileContents: async requests => new Map(requests.map(request => {
                    const key = fileContentKey(request.commitId, request.path);
                    const content = contents.get(key);
                    if (content === undefined) { throw new Error(`Missing fixture file ${key}`); }
                    return [key, content];
                })),
                listFiles: async () => [
                    { path: '.github', directory: true }, { path: 'src', directory: true },
                ],
            },
            ...overrides,
        };
        comments.setPrContext(
            undefined, 42, [...target.filePaths], undefined, target.changeTypes,
            'base', 'source', 'org/project/repo/42',
            new Map([['src/app.ts', 17]]), 2, 1, 2,
        );
        comments.setReviewMode(true);
        const dependencies: CopilotReviewDependencies = {
            prepareTarget: async () => target,
            currentTarget: () => target,
            comments, lenses: { resolveLens: async id => getBuiltInReviewLens(id ?? 'general') }, log,
        };
        const service = new CopilotReviewService(dependencies);
        disposables.push(service, comments, log);
        return {
            service, comments, contents, dependencies,
            target: () => target,
            changeTarget: (changes: Partial<ReviewTarget>) => { target = { ...target, ...changes }; },
        };
    }

    function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
        return { path: 'src/app.ts', line: 1, body: 'Validate input before assigning it.', type: 'issue', ...overrides };
    }

    function thread(id = 10): GitPullRequestCommentThread {
        return {
            id, comments: [{ id: 1, content: 'Please validate this input.', commentType: CommentType.Text }],
            threadContext: { filePath: '/src/app.ts', rightFileStart: { line: 1, offset: 1 }, rightFileEnd: { line: 1, offset: 20 } },
        };
    }

    async function resolution(f: ReturnType<typeof fixture>, kind: 'fix' | 'explain' = 'fix') {
        const comment = { thread: thread(), filePath: 'src/app.ts', startLine: 1, startCol: 1, endLine: 1, endCol: 20 };
        await f.comments.updateThreads([comment.thread]);
        return f.service.start({ kind, comment, commentCommit: 'source' });
    }

    test('captures immutable content, selected comparison, and the selected review lens', async () => {
        const f = fixture();
        const id = await f.service.start({ lensId: 'security' });
        f.contents.set(fileContentKey('source', 'src/app.ts'), 'changed later');
        const context = JSON.stringify(await f.service.context(id, token));
        assert.ok(context.includes('"sourceCommit":"source"'));
        assert.ok(context.includes('"compareToIterationId":1'));
        assert.ok(context.includes('Review Lens: Security'));
        assert.ok(context.includes('azdoCreateReviewDrafts'));
        const read = JSON.stringify(await f.service.read(id, 'src/app.ts', 'source', 1, 2, token));
        assert.ok(read.includes('const value = input;'));
        assert.ok(!read.includes('changed later'));
    });

    test('reads source, base, diff, and surrounding instruction files without a checkout', async () => {
        const f = fixture();
        const id = await f.service.start();
        assert.ok(JSON.stringify(await f.service.read(id, 'src/app.ts', 'base', 1, 20, token)).includes('const value = 0;'));
        assert.ok(JSON.stringify(await f.service.read(id, 'src/app.ts', 'diff', 1, 20, token)).includes('@@ -1,2 +1,2 @@'));
        assert.ok(JSON.stringify(await f.service.read(id, '.github/copilot-instructions.md', 'source', 1, 20, token)).includes('Check error handling.'));
        assert.ok(JSON.stringify(await f.service.list(id, '', 0, token)).includes('.github'));
        await assert.rejects(f.service.read(id, '../secret', 'source', 1, 20, token), /repository-relative/);
        await assert.rejects(f.service.read(id, 'src/unknown.ts', 'diff', 1, 20, token), /not changed/);
    });

    test('reads original historical comment paths and revisions independently of the current diff', async () => {
        const f = fixture();
        const id = await f.service.start({
            kind: 'explain', commentCommit: 'historical',
            comment: { thread: thread(), filePath: 'old/app.ts', startLine: 1, endLine: 1, startCol: 1, endCol: 4 },
        });
        assert.ok(JSON.stringify(await f.service.read(id, 'old/app.ts', 'comment', 1, 10, token)).includes('old targeted code'));
        await assert.rejects(f.service.read(id, 'src/app.ts', 'comment', 1, 10, token), /Original comment content is unavailable/);
    });

    test('enforces the exact 2000-line read threshold and reports pagination', async () => {
        const f = fixture();
        f.contents.set(fileContentKey('source', 'src/app.ts'), Array.from({ length: 2001 }, (_, i) => `line ${i + 1}`).join('\n'));
        const id = await f.service.start();
        const read = JSON.stringify(await f.service.read(id, 'src/app.ts', 'source', 1, 2000, token));
        assert.ok(read.includes('"hasMore":true'));
        assert.ok(read.includes('"endLine":2000'));
        assert.ok(!read.includes('2001: line'));
        await assert.rejects(f.service.read(id, 'src/app.ts', 'source', 1, 2001, token), /at most 2000/);
        await assert.rejects(f.service.read(id, 'src/app.ts', 'source', 0, 1, token), /1-based/);
        await assert.rejects(f.service.read(id, 'src/app.ts', 'source', 2002, 2003, token), /only 2001/);
    });

    test('paginates directories and search matches without silently dropping results', async () => {
        const f = fixture();
        f.target().service!.listFiles = async () => Array.from({ length: 201 }, (_, i) => ({ path: `file${i}`, directory: false }));
        f.contents.set(fileContentKey('source', 'src/app.ts'), Array.from({ length: 201 }, () => 'needle').join('\n'));
        const id = await f.service.start();
        assert.ok(JSON.stringify(await f.service.list(id, '', 0, token)).includes('"nextOffset":200'));
        const second = JSON.stringify(await f.service.list(id, '', 200, token));
        assert.ok(second.includes('file200'));
        assert.ok(!second.includes('file199'));
        assert.ok(JSON.stringify(await f.service.search(id, 'needle', undefined, token)).includes('"nextOffset":200'));
        const matches = JSON.stringify(await f.service.search(id, 'needle', undefined, token, 200));
        assert.ok(matches.includes('"line":201'));
        assert.ok(!matches.includes('"line":200,'));
        assert.ok(matches.includes('Changed source files only'));
        assert.ok(JSON.stringify(await f.service.search(id, 'error', ['.github/copilot-instructions.md'], token)).includes('Check error handling.'));
    });

    test('creates editable native draft comments and deduplicates retries, including dismissed findings', async () => {
        const f = fixture();
        const id = await f.service.start();
        assert.deepStrictEqual(await f.service.createDrafts(id, [finding()], token), { created: 1, alreadyCreated: 0, published: false });
        assert.strictEqual(f.comments.draftCount, 1);
        assert.deepStrictEqual(await f.service.createDrafts(id, [finding()], token), { created: 0, alreadyCreated: 1, published: false });
        f.comments.clearDrafts();
        await f.service.createDrafts(id, [finding()], token);
        assert.strictEqual(f.comments.draftCount, 0);
    });

    test('validates every finding before creating any draft', async () => {
        const f = fixture();
        const id = await f.service.start();
        for (const invalid of [
            finding({ path: '../app.ts' }), finding({ path: 'not-changed.ts' }),
            finding({ line: 0 }), finding({ line: 100 }), finding({ line: 2, endLine: 1 }),
            finding({ body: ' ' }),
        ]) {
            await assert.rejects(f.service.createDrafts(id, [finding(), invalid], token));
            assert.strictEqual(f.comments.draftCount, 0);
        }
    });

    test('anchors deleted-file findings to the base and retains comparison metadata across iteration switches', async () => {
        const f = fixture({ changeTypes: new Map([['src/app.ts', VersionControlChangeType.Delete]]) });
        const id = await f.service.start();
        await assert.rejects(f.service.createDrafts(id, [finding()], token), /not present/);
        await f.service.createDrafts(id, [finding({ side: 'left', endLine: 2 })], token);
        const saved = f.comments.serializeDrafts();
        assert.strictEqual(saved.aiDrafts[0].side, 'left');
        assert.strictEqual(saved.aiDrafts[0].endLine, 2);
        assert.strictEqual(saved.aiDrafts[0].iterationId, 2);
        assert.strictEqual(saved.aiDrafts[0].compareToIterationId, 1);
        f.comments.setPrContext(undefined, 42, ['src/app.ts'], undefined, undefined, 'new-base', 'new-source', 'org/project/repo/42', undefined, 3, 2);
        f.comments.restoreDrafts(saved);
        const restored = f.comments.serializeDrafts().aiDrafts[0];
        assert.strictEqual(restored.targetRef, 'base');
        assert.strictEqual(restored.sourceRef, 'source');
        assert.strictEqual(restored.changeTrackingId, 17);
        assert.strictEqual(restored.iterationId, 2);
    });

    test('does not overwrite an edited draft with its persisted original body', async () => {
        const f = fixture();
        const draft = f.comments.createDraftThread('src/app.ts', 1, 'original');
        assert.ok(draft);
        const createDraft = f.comments.createDraftThread.bind(f.comments);
        let restored: vscode.CommentThread | undefined;
        f.comments.createDraftThread = (...args) => {
            restored = createDraft(...args);
            return restored;
        };
        f.comments.restoreDrafts(f.comments.serializeDrafts());
        assert.ok(restored);
        f.comments.updateAiDraft(restored, 'edited after restoring');
        assert.strictEqual(f.comments.getDraftInfo(restored)?.body, 'edited after restoring');
        assert.strictEqual(f.comments.serializeDrafts().aiDrafts[0].body, 'edited after restoring');
    });

    test('rejects stale repository, PR, and iteration runs before reading or creating drafts', async () => {
        const f = fixture();
        const id = await f.service.start();
        for (const identity of ['other-repo/42', 'repo/43', 'repo/42:source3:base2']) {
            f.changeTarget({ identity });
            await assert.rejects(f.service.read(id, 'src/app.ts', 'source', 1, 3, token), /stale/);
            await assert.rejects(f.service.createDrafts(id, [finding()], token), /stale/);
            assert.strictEqual(f.comments.draftCount, 0);
        }
    });

    test('rechecks identity after asynchronous reads', async () => {
        const f = fixture();
        const id = await f.service.start();
        f.target().service!.getFileContents = async requests => {
            f.changeTarget({ identity: 'different-pr' });
            return new Map(requests.map(request => [fileContentKey(request.commitId, request.path), 'late content']));
        };
        await assert.rejects(f.service.read(id, 'new-file.ts', 'source', 1, 3, token), /stale/);
    });

    test('rejects cancellations without creating drafts or starting a replacement run', async () => {
        const f = fixture();
        const id = await f.service.start();
        const cancellation = new vscode.CancellationTokenSource();
        cancellation.cancel();
        await assert.rejects(f.service.createDrafts(id, [finding()], cancellation.token), vscode.CancellationError);
        let prepared = false;
        f.dependencies.prepareTarget = async () => { prepared = true; return f.target(); };
        await assert.rejects(f.service.context(undefined, cancellation.token), vscode.CancellationError);
        assert.strictEqual(prepared, false);
        assert.strictEqual(f.comments.draftCount, 0);
        cancellation.dispose();
    });

    test('requires Review Mode before creating PR drafts', async () => {
        const f = fixture();
        const id = await f.service.start();
        f.comments.setReviewMode(false);
        await assert.rejects(f.service.createDrafts(id, [finding()], token), /Review Mode is off/);
    });

    test('honors cancellation during lens loading and Review Mode changes while preparing findings', async () => {
        const f = fixture();
        const cancellation = new vscode.CancellationTokenSource();
        f.dependencies.lenses.resolveLens = async () => {
            cancellation.cancel();
            return getBuiltInReviewLens('general');
        };
        await assert.rejects(f.service.start({}, cancellation.token), vscode.CancellationError);
        cancellation.dispose();
        f.dependencies.lenses.resolveLens = async () => getBuiltInReviewLens('general');
        const id = await f.service.start();
        const creating = f.service.createDrafts(id, [finding()], token);
        f.comments.setReviewMode(false);
        await assert.rejects(creating, /Review Mode is off/);
        assert.strictEqual(f.comments.draftCount, 0);
    });

    test('prefills only the captured thread, keeps replies local, and does not overwrite a user draft', async () => {
        const f = fixture();
        const id = await resolution(f);
        assert.deepStrictEqual(f.service.draftReply(id, 'I will validate this.', token), { drafted: true, published: false });
        assert.strictEqual(f.comments.serializeDrafts().replyDrafts[0].azdoThreadId, 10);
        assert.strictEqual(f.comments.serializeDrafts().replyDrafts[0].body, 'I will validate this.');
        assert.ok(JSON.stringify(f.service.draftReply(id, 'I will validate this.', token)).includes('"alreadyCreated":true'));
        const another = await resolution(f);
        assert.throws(() => f.service.draftReply(another, 'Replace the existing draft', token), /already has a reply draft/);
        f.changeTarget({ identity: 'new-pr' });
        assert.throws(() => f.service.draftReply(id, 'Wrong PR', token), /stale/);
    });

    test('quick reviews and explanations cannot create findings, replies, or fixes', async () => {
        const f = fixture();
        for (const kind of ['quick', 'explain'] as const) {
            const id = kind === 'explain' ? await resolution(f, kind) : await f.service.start({ kind });
            await assert.rejects(f.service.createDrafts(id, [finding()], token), /Only a detailed review/);
            assert.throws(() => f.service.draftReply(id, 'reply', token), /comment-resolution/);
            await assert.rejects(f.service.proposeFix(id, 'src/app.ts', 'x', 'y', token), /comment-resolution/);
        }
    });

    test('allows no-checkout replies but explicitly rejects code changes', async () => {
        const f = fixture();
        const id = await resolution(f);
        assert.ok(JSON.stringify(await f.service.context(id, token)).includes('"canProposeFix":false'));
        await assert.rejects(f.service.read(id, 'src/app.ts', 'checkout', 1, 3, token), /checked-out/);
        await assert.rejects(f.service.proposeFix(id, 'src/app.ts', 'input', '0', token), /checked-out/);
        f.service.draftReply(id, 'Please validate the input.', token);
        assert.strictEqual(f.comments.serializeDrafts().replyDrafts.length, 1);
    });

    test('proposes idempotent fixes without editing files, requires approval, and applies the exact preview', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'azdo-ai-fix-'));
        temporaryDirectories.push(root);
        await fs.mkdir(path.join(root, 'src'));
        await fs.writeFile(path.join(root, 'src', 'app.ts'), 'const value = input;\n');
        const f = fixture({ checkoutBacked: true, repositoryRoot: vscode.Uri.file(root) });
        const id = await resolution(f);
        const proposal = await f.service.proposeFix(id, 'src/app.ts', 'input', 'validate(input)', token);
        const retry = await f.service.proposeFix(id, 'src/app.ts', 'input', 'validate(input)', token);
        assert.strictEqual(proposal.proposalId, retry.proposalId);
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'src', 'app.ts')));
        assert.strictEqual(document.getText(), 'const value = input;\n');
        assert.strictEqual(f.service.provideTextDocumentContent(vscode.Uri.from({ scheme: 'azdo-pr-ai-fix', authority: proposal.proposalId })), 'const value = validate(input);\n');
        await f.service.applyFix(proposal.proposalId, async () => false);
        assert.strictEqual(document.getText(), 'const value = input;\n');
        await f.service.applyFix(proposal.proposalId, async () => true);
        assert.strictEqual(document.getText(), 'const value = validate(input);\n');
        await document.save();
        await assert.rejects(f.service.applyFix(proposal.proposalId, async () => true), /no longer available/);
    });

    test('rejects ambiguous originals and fixes made stale during the approval prompt', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'azdo-ai-stale-fix-'));
        temporaryDirectories.push(root);
        await fs.mkdir(path.join(root, 'src'));
        const uri = vscode.Uri.file(path.join(root, 'src', 'app.ts'));
        await fs.writeFile(uri.fsPath, 'input + input;\n');
        const f = fixture({ checkoutBacked: true, repositoryRoot: vscode.Uri.file(root) });
        const id = await resolution(f);
        await assert.rejects(f.service.proposeFix(id, 'src/app.ts', 'input', 'valid', token), /exactly once/);
        const proposal = await f.service.proposeFix(id, 'src/app.ts', 'input + input', 'valid', token);
        await assert.rejects(f.service.applyFix(proposal.proposalId, async () => {
            const document = await vscode.workspace.openTextDocument(uri);
            const edit = new vscode.WorkspaceEdit();
            edit.insert(uri, document.positionAt(0), '// user edit\n');
            await vscode.workspace.applyEdit(edit);
            return true;
        }), /changed while awaiting approval/);
        const document = await vscode.workspace.openTextDocument(uri);
        assert.ok(document.getText().includes('input + input'));
        await document.save();
    });

    test('rejects checkout reads and fixes through a directory link outside the reviewed repository', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'azdo-ai-boundary-'));
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'azdo-ai-outside-'));
        temporaryDirectories.push(root, outside);
        await fs.writeFile(path.join(outside, 'outside.ts'), 'outside code\n');
        await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
        const f = fixture({ checkoutBacked: true, repositoryRoot: vscode.Uri.file(root) });
        const id = await resolution(f);
        await assert.rejects(f.service.read(id, 'linked/outside.ts', 'checkout', 1, 10, token), /outside the reviewed repository/);
        await assert.rejects(f.service.proposeFix(id, 'linked/outside.ts', 'outside', 'modified', token), /outside the reviewed repository/);
        assert.strictEqual(await fs.readFile(path.join(outside, 'outside.ts'), 'utf8'), 'outside code\n');
    });

    test('discards runs explicitly and when the service is disposed', async () => {
        const f = fixture();
        const first = await f.service.start();
        f.service.discard(first);
        await assert.rejects(f.service.context(first, token), /expired/);
        const second = await f.service.start();
        f.service.dispose();
        await assert.rejects(f.service.context(second, token), /expired/);
    });
});

suite('Review lens structured-tool protocol', () => {
    test('preserves all built-in lens priorities while replacing the text-block protocol', () => {
        assert.deepStrictEqual(BUILT_IN_REVIEW_LENSES.map(lens => lens.id), [
            'general', 'bugs', 'security', 'architecture', 'performance', 'project-maintainer-review',
        ]);
        for (const lens of BUILT_IN_REVIEW_LENSES) {
            const prompt = buildReviewPrompt(lens);
            assert.ok(prompt.includes(lens.prompt));
            assert.ok(prompt.includes('azdoCreateReviewDrafts'));
            assert.ok(!prompt.includes('[REVIEW_COMMENT]'));
        }
        const maintainer = buildReviewPrompt(getBuiltInReviewLens('project-maintainer-review')!);
        assert.ok(maintainer.includes('First review whether the change should exist'));
        assert.ok(maintainer.includes('Provide a calibration ledger'));
        assert.ok(maintainer.includes('Do not edit, post, commit, fetch, restore or build'));
    });
});
