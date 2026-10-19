import * as assert from 'assert';
import * as vscode from 'vscode';
import { readFile, rename, writeFile } from 'fs/promises';
import type { DevelopmentReviewApi } from '../../extension';
import type { GitExtension } from '../../typings/git';
import { COPILOT_SESSION_COMMAND, openCopilotReview } from '../../chat/copilotReview';
import { gitText } from '../../chat/reviewContent';

async function waitFor<T>(description: string, read: () => Promise<T>, ready: (value: T) => boolean, timeout = 180000): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await read();
        if (ready(value)) { return value; }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for ${description}. Check the isolated Copilot session and tool approval prompts.`);
}

export async function runCopilotSmoke(): Promise<void> {
    const resultPath = process.env.AZDO_COPILOT_SMOKE_RESULT;
    if (process.env.AZDO_COPILOT_SMOKE !== '1' || !resultPath) {
        throw new Error('The real Copilot smoke test requires its explicit opt-in runner.');
    }
    const result: { success: boolean; drafts?: number; harnessCheckpoints?: number; repositoryUnchanged?: boolean; error?: string } = { success: false };
    try {
        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(workspace, 'The synthetic fixture must be open.');
        assert.ok(workspace.fsPath.endsWith('copilot\\workspace') || workspace.fsPath.endsWith('copilot/workspace'));
        const git = vscode.extensions.getExtension<GitExtension>('vscode.git');
        assert.ok(git);
        const gitApi = (await git.activate()).getAPI(1);
        await waitFor('the synthetic Git repository', async () => gitApi.repositories, repos => repos.some(repo =>
            repo.rootUri.toString() === workspace.toString() && !!repo.state.HEAD?.commit), 30000);
        assert.strictEqual((await gitText(workspace.fsPath, ['remote'])).trim(), '', 'The smoke test must never have a remote.');
        const beforeHead = await gitText(workspace.fsPath, ['rev-parse', 'HEAD']);
        const ordinaryRefs = ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/', 'refs/remotes/', 'refs/tags/'];
        const beforeRefs = await gitText(workspace.fsPath, ordinaryRefs);
        const beforeIndex = await gitText(workspace.fsPath, ['ls-files', '--stage']);
        const beforeFile = await readFile(vscode.Uri.joinPath(workspace, 'calculator.ts').fsPath, 'utf8');
        const extension = vscode.extensions.getExtension<DevelopmentReviewApi>('vinaydommeti.vscode-pr-azdo');
        assert.ok(extension);
        const api = await extension.activate();
        assert.ok(api?.copilotReview, 'Development API must expose Copilot review runs.');
        await vscode.commands.executeCommand('workbench.action.chat.open');
        await waitFor('the Copilot harness', async () => vscode.commands.getCommands(true), commands => commands.includes(COPILOT_SESSION_COMMAND), 60000);
        const runId = await api.copilotReview.start({ targetBranch: 'main', mode: 'vs-target' });
        await openCopilotReview(runId);
        const drafts = await waitFor(
            'a real Copilot-generated native review draft',
            async () => api.commentController.serializeDrafts().aiDrafts,
            drafts => drafts.some(draft => draft.filePath === 'calculator.ts' && (draft.line === 3 || draft.line === 4)),
        );
        result.drafts = drafts.length;
        for (const draft of drafts) {
            assert.strictEqual(draft.localOnly, true);
            assert.ok(draft.body.trim());
            assert.strictEqual(draft.documentContent, beforeFile);
            assert.ok(draft.documentUri);
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(draft.documentUri));
            assert.strictEqual(document.getText(), beforeFile, 'Native draft documents must show the exact reviewed code.');
        }
        assert.strictEqual(await gitText(workspace.fsPath, ['rev-parse', 'HEAD']), beforeHead);
        assert.strictEqual(await gitText(workspace.fsPath, ordinaryRefs), beforeRefs);
        assert.strictEqual(await gitText(workspace.fsPath, ['ls-files', '--stage']), beforeIndex);
        assert.strictEqual(await readFile(vscode.Uri.joinPath(workspace, 'calculator.ts').fsPath, 'utf8'), beforeFile);
        assert.strictEqual((await gitText(workspace.fsPath, ['status', '--porcelain'])).trim(), '');
        result.repositoryUnchanged = true;
        result.harnessCheckpoints = (await gitText(workspace.fsPath, ['for-each-ref', '--format=%(refname)', 'refs/agents/'])).trim().split('\n').filter(Boolean).length;
        result.success = true;
    } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
    } finally {
        await writeFile(`${resultPath}.tmp`, JSON.stringify(result, null, 2));
        await rename(`${resultPath}.tmp`, resultPath);
        const commands = await vscode.commands.getCommands(true);
        if (commands.includes('workbench.action.chat.cancel')) {
            await vscode.commands.executeCommand('workbench.action.chat.cancel');
        }
        await vscode.commands.executeCommand('workbench.action.closeWindow');
    }
}
