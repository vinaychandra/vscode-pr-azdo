import * as assert from 'assert';
import * as vscode from 'vscode';
import { appendAutoRoutingPrompt } from '../../chat/prChatParticipant';

suite('appendAutoRoutingPrompt', () => {
    test('leaves a textual user message for Copilot Auto routing', () => {
        const messages = [
            vscode.LanguageModelChatMessage.Assistant([
                new vscode.LanguageModelToolCallPart('call-1', 'tool', {}),
            ]),
            vscode.LanguageModelChatMessage.User([
                new vscode.LanguageModelToolResultPart('call-1', [
                    new vscode.LanguageModelTextPart('tool output'),
                ]),
            ]),
        ];

        appendAutoRoutingPrompt(messages, 'Continue reviewing the pull request changes.');

        const lastMessage = messages[messages.length - 1];
        assert.strictEqual(lastMessage.role, vscode.LanguageModelChatMessageRole.User);
        assert.ok(lastMessage.content.some(part =>
            part instanceof vscode.LanguageModelTextPart && part.value.trim().length > 0,
        ));
    });
});