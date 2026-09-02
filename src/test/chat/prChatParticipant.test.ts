import * as assert from 'assert';
import * as vscode from 'vscode';
import { appendAutoRoutingPrompt, buildReviewDiffArgs, parseReviewArguments } from '../../chat/prChatParticipant';
import { BUILT_IN_REVIEW_LENSES, buildReviewChatQuery, buildReviewPrompt } from '../../chat/reviewLenses';

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

suite('buildReviewDiffArgs', () => {
    test('uses immutable target and source refs for snapshot reviews', () => {
        assert.deepStrictEqual(
            buildReviewDiffArgs('target-sha', ['src/a.ts', 'README.md'], 'vs-target', 'origin/local', 'source-sha'),
            ['diff', 'target-sha', 'source-sha', '--', 'src/a.ts', 'README.md'],
        );
    });
});

suite('review lenses', () => {
    test('ships the expected built-in lenses in order', () => {
        assert.deepStrictEqual(BUILT_IN_REVIEW_LENSES.map(lens => lens.id), [
            'general', 'bugs', 'security', 'architecture', 'performance',
        ]);
    });

    test('composes every lens with the structured output protocol', () => {
        for (const lens of BUILT_IN_REVIEW_LENSES) {
            const prompt = buildReviewPrompt(lens);
            assert.ok(prompt.includes('[REVIEW_COMMENT]'));
            assert.ok(prompt.includes(`Review Lens: ${lens.name}`));
            assert.ok(prompt.includes(lens.prompt));
        }
    });

    test('parses lens and mode in either order while preserving instructions', () => {
        assert.deepStrictEqual(
            parseReviewArguments('--lens=security review auth --mode=vs-target'),
            { mode: 'vs-target', lensId: 'security', cleanPrompt: 'review auth' },
        );
        assert.deepStrictEqual(
            parseReviewArguments('--mode=staged --lens=my%20lens focus here'),
            { mode: 'staged', lensId: 'my lens', cleanPrompt: 'focus here' },
        );
    });

    test('round-trips an encoded custom lens ID into a review query', () => {
        const query = buildReviewChatQuery('custom:API Contracts.md', 'vs-target');
        const prompt = query.substring('@azdo-pr /review '.length);

        assert.deepStrictEqual(parseReviewArguments(prompt), {
            mode: 'vs-target',
            lensId: 'custom:API Contracts.md',
            cleanPrompt: '',
        });
    });
});