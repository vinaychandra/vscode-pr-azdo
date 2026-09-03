import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
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
	});
});
