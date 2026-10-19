import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { COPILOT_REVIEW_TOOL_IDS } from '../chat/copilotReview';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('registers the pull request URL review command', async () => {
		const extension = vscode.extensions.getExtension('vinaydommeti.vscode-pr-azdo');
		assert.ok(extension);
		await extension.activate();
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('vscode-pr-azdo.reviewPullRequestFromUrl'));
		const contribution = extension.packageJSON.contributes.commands.find(
			(command: { command: string }) => command.command === 'vscode-pr-azdo.reviewPullRequestFromUrl',
		);
		assert.strictEqual(contribution?.title, 'Azure DevOps PR: Review Pull Request from URL');
	});

	test('contributes the restricted Copilot agent and all structured review tools without a participant', async () => {
		const extension = vscode.extensions.getExtension('vinaydommeti.vscode-pr-azdo');
		assert.ok(extension);
		await extension.activate();
		const manifest = extension.packageJSON as {
			contributes: {
				chatParticipants?: unknown;
				chatAgents: { path: string; sessionTypes: string[] }[];
				languageModelTools: { name: string; toolReferenceName: string; canBeReferencedInPrompt: boolean }[];
			};
		};
		assert.strictEqual(manifest.contributes.chatParticipants, undefined);
		const agent = manifest.contributes.chatAgents[0];
		assert.deepStrictEqual(agent.sessionTypes, ['agent-host-copilotcli']);
		const agentText = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extension.extensionUri, agent.path))).toString('utf8');
		assert.ok(agentText.includes('name: Azure DevOps Review'));
		const available = new Set(vscode.lm.tools.map(tool => tool.name));
		assert.strictEqual(manifest.contributes.languageModelTools.length, COPILOT_REVIEW_TOOL_IDS.length);
		for (const tool of manifest.contributes.languageModelTools) {
			assert.ok(available.has(tool.name), `${tool.name} must be available through the LM Tools API`);
			assert.strictEqual(tool.canBeReferencedInPrompt, true);
			assert.ok(agentText.includes(`vinaydommeti.vscode-pr-azdo/${tool.toolReferenceName}`));
		}
		const listedTools = agentText.match(/^  - .+$/gm) ?? [];
		assert.strictEqual(listedTools.length, COPILOT_REVIEW_TOOL_IDS.length);
		const files = await vscode.commands.executeCommand<{ type: string; extensionId: string }[]>('_listExtensionPromptFiles');
		assert.ok(files.some(file => file.extensionId === extension.id && file.type === 'agent'), 'VS Code must actually discover the contributed review agent');
	});
});
