import * as assert from 'assert';
import * as vscode from 'vscode';
import { appendAutoRoutingPrompt, appendToolRound, buildReviewDiffArgs, openPrChat, parseReviewArguments, requiresCheckoutForAi } from '../../chat/prChatParticipant';
import { BUILT_IN_REVIEW_LENSES, buildReviewChatQuery, buildReviewPrompt, getBuiltInReviewLens } from '../../chat/reviewLenses';

suite('openPrChat', () => {
    test('opens the review in a new Local session before submitting the participant query', async () => {
        const calls: unknown[][] = [];
        await openPrChat('@azdo-pr /review --mode=vs-target', {
            getCommands: async () => ['workbench.action.chat.newLocalChat'],
            executeCommand: async <Result>(command: string, ...args: unknown[]) => {
                calls.push([command, ...args]);
                return undefined as Result;
            },
        });
        assert.deepStrictEqual(calls, [
            ['workbench.action.chat.open'],
            ['workbench.action.chat.newLocalChat'],
            ['workbench.action.chat.open', { query: '@azdo-pr /review --mode=vs-target' }],
        ]);
    });

    test('supports older VS Code builds without the Local harness command', async () => {
        const calls: unknown[][] = [];
        await openPrChat('@azdo-pr /fix', {
            getCommands: async () => [],
            executeCommand: async <Result>(command: string, ...args: unknown[]) => {
                calls.push([command, ...args]);
                return undefined as Result;
            },
        });
        assert.deepStrictEqual(calls, [['workbench.action.chat.open', { query: '@azdo-pr /fix' }]]);
    });

    test('does not submit the review to an incompatible harness if Local session creation fails', async () => {
        const calls: string[] = [];
        await assert.rejects(openPrChat('@azdo-pr /review', {
            getCommands: async () => ['workbench.action.chat.newLocalChat'],
            executeCommand: async <Result>(command: string) => {
                calls.push(command);
                if (command.endsWith('newLocalChat')) { throw new Error('Cannot open Local chat'); }
                return undefined as Result;
            },
        }), /Cannot open Local chat/);
        assert.deepStrictEqual(calls, ['workbench.action.chat.open', 'workbench.action.chat.newLocalChat']);
    });
});

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

suite('appendToolRound', () => {
    for (const text of ['', 'Inspecting the relevant files.']) {
        test(`keeps parallel tool calls and results in matching turns ${text ? 'with' : 'without'} text`, () => {
            const messages: vscode.LanguageModelChatMessage[] = [];
            const calls = [
                new vscode.LanguageModelToolCallPart('call-1', 'read', {}),
                new vscode.LanguageModelToolCallPart('call-2', 'search', {}),
            ];
            const results = [
                new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('file content')]),
                new vscode.LanguageModelToolResultPart('call-2', [new vscode.LanguageModelTextPart('Error: search failed')]),
            ];

            appendToolRound(messages, text, calls, results);
            appendAutoRoutingPrompt(messages, 'Continue reviewing.');

            assert.strictEqual(messages.length, 3);
            assert.strictEqual(messages[0].role, vscode.LanguageModelChatMessageRole.Assistant);
            assert.deepStrictEqual(messages[0].content.filter(part => part instanceof vscode.LanguageModelToolCallPart), calls);
            assert.deepStrictEqual(messages[0].content.filter(part => part instanceof vscode.LanguageModelTextPart).map(part => part.value), text ? [text] : []);
            assert.strictEqual(messages[1].role, vscode.LanguageModelChatMessageRole.User);
            assert.deepStrictEqual(messages[1].content, results);
            assert.ok(messages[2].content[0] instanceof vscode.LanguageModelTextPart);
        });
    }
});

suite('requiresCheckoutForAi', () => {
    test('blocks fix and PR review commands but allows read-only explanation', () => {
        assert.strictEqual(requiresCheckoutForAi('fix'), true);
        assert.strictEqual(requiresCheckoutForAi('review'), true);
        assert.strictEqual(requiresCheckoutForAi('review-quick'), true);
        assert.strictEqual(requiresCheckoutForAi('explain'), false);
        assert.strictEqual(requiresCheckoutForAi(undefined), false);
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
            'project-maintainer-review',
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

    test('preserves the maintainer skill priorities and boundaries in the structured review prompt', () => {
        const lens = getBuiltInReviewLens('project-maintainer-review');
        assert.ok(lens);

        const prompt = buildReviewPrompt(lens);

        assert.ok(prompt.includes('First review whether the change should exist'));
        for (const check of ['Removal', 'Information', 'Ownership', 'Existing mechanism', 'Contract', 'Producer/lifecycle']) {
            assert.ok(prompt.includes(`**${check}:**`));
        }
        assert.ok(prompt.includes('Do not edit, post, commit, fetch, restore or build'));
        assert.ok(prompt.includes('`src\\tools` unless changed'));
        assert.ok(prompt.includes('## Phase 2: execution, cost and test fit'));
        assert.ok(prompt.includes('without a runtime-bug, consensus or comment-quota gate'));
        assert.ok(prompt.includes('Provide a calibration ledger'));
        assert.ok(prompt.includes('type: <suggestion|issue|nitpick|question>'));
    });

    test('routes the built-in maintainer lens through the review chat query', () => {
        const query = buildReviewChatQuery('project-maintainer-review', 'vs-target');

        assert.deepStrictEqual(parseReviewArguments(query.substring('@azdo-pr /review '.length)), {
            mode: 'vs-target',
            lensId: 'project-maintainer-review',
            cleanPrompt: '',
        });
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