import * as vscode from 'vscode';
import { execFile } from 'child_process';
import type { PrContextProvider } from './prContextProvider';
import type { PrCommentController } from '../views/prCommentController';
import { hasSuggestion, extractSuggestion } from '../views/suggestionRenderer';
import { CommentType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { API } from '../typings/git';
import type { RepositoryDetector } from '../azdo/repositoryDetector';
import { getActiveRepository } from '../git/gitExtension';
import { type ReviewMode, buildGitDiffArgs, reviewModeLabel } from '../git/gitStateDetector';
import { buildGitRefUri } from '../views/gitRefContentProvider';
import { buildReviewPrompt, getBuiltInReviewLens, type ReviewLensService } from './reviewLenses';

const PARTICIPANT_ID = 'vscode-pr-azdo.pr-assistant';

/** Tools that require toolInvocationToken and cannot be used from a chat participant. */
const BLOCKED_TOOL_NAMES = new Set([
    'copilot_applyPatch', 'copilot_replaceString', 'copilot_multiReplaceString',
    'copilot_insertEdit', 'copilot_createFile', 'copilot_createDirectory',
    'copilot_editNotebook', 'copilot_editFiles', 'copilot_runVscodeCommand',
    'copilot_installExtension', 'copilot_switchAgent',
    'run_in_terminal', 'vscode_get_terminal_confirmation',
]);

const MAX_TOOLS = 128;

function getChatTools(snapshotReview = false): { name: string; description: string; inputSchema: object }[] {
    const all = vscode.lm.tools
        .filter(t => !BLOCKED_TOOL_NAMES.has(t.name))
        .filter(t => !snapshotReview || t.name.startsWith('vscode-pr-azdo_'))
        .map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? {} }));
    if (all.length > MAX_TOOLS) {
        void vscode.window.showWarningMessage(
            `${all.length} tools available but the limit is ${MAX_TOOLS}. Some tools will not be available to the AI assistant.`,
        );
        return all.slice(0, MAX_TOOLS);
    }
    return all;
}

export const DEFAULT_REVIEW_PROMPT = buildReviewPrompt(getBuiltInReviewLens('general')!);

export const DEFAULT_REVIEW_QUICK_PROMPT = `You are an expert code reviewer. Provide a quick, high-level review of this pull request.

BEFORE starting your review, search the workspace for instruction files and read any that exist:
- \`.github/copilot-instructions.md\` — repo-level instructions
- \`**/.instructions.md\` — directory-scoped instructions (may appear at any level)
- \`.copilot/\` directory — may contain additional instruction or prompt files
Follow any instructions found as general coding and review guidelines.

Focus on:
- What the PR does (brief summary)
- Key concerns or risks
- Architecture / design observations
- Any obvious bugs or security issues

Keep it concise. Do NOT produce [REVIEW_COMMENT] blocks — just a clear summary.`;

export const DEFAULT_SYSTEM_PROMPT = `You are an AI assistant integrated into a VS Code extension for Azure DevOps pull request reviews.

## Your Role
You help developers resolve PR review comments. You will receive:
- The comment thread (all comments, authors, timestamps)
- The file path, line range, and column range where the comment was made
- The exact text being targeted by the comment
- PR metadata (title, description, branches, changed files)

## Tools
You have access to the full workspace via tools. USE THEM:
- Read files to understand surrounding code, imports, and dependencies
- Search for symbols, types, or functions referenced in the comment or code
- Look up related files to understand the broader context
Do NOT guess about code structure or behavior — look it up first.

## User Instructions
BEFORE responding, search the workspace for instruction files and read any that exist:
- \`.github/copilot-instructions.md\` — repo-level instructions
- \`**/.instructions.md\` — directory-scoped instructions (may appear at any level)
- \`.copilot/\` directory — may contain additional instruction or prompt files
Follow any instructions found as general coding guidelines.

**IMPORTANT: Do NOT edit or modify any files directly.** Your role is to SUGGEST changes.
Provide all code fixes as fenced code blocks in your response. The user will review and apply them.

## How to Respond

Analyze the comment and determine what it needs:

### 1. Code Fix Needed
If the comment asks for a code change (refactor, bug fix, rename, etc.):
- Briefly explain what needs to change and why
- Provide the exact fixed code in a fenced code block with the language identifier
- The code block should show the complete replacement for the affected section
- Reference the file path: \`File: path/to/file.ts\`

### 2. Answer / Explanation Needed
If the comment asks a question or needs a text response:
- Draft a clear, concise reply addressing the question
- IMPORTANT: Wrap the reply in a REPLY block so it can be posted to Azure DevOps:
  [REPLY]
  Your reply text here
  [/REPLY]
- Support your answer with references to specific code or files when relevant

### 3. Both
If the comment needs both a code change and a response:
- Provide the code fix first
- Then the reply draft in a [REPLY] block

## Rules
- Be direct and practical — write as a team member, not a generic assistant
- Do NOT add unnecessary caveats, disclaimers, or "feel free to adjust" filler
- When fixing code, match the existing style (indentation, naming conventions, patterns)
- If the comment contains a \`\`\`suggestion\`\`\` block, that IS the requested change — explain it and help apply it
- File paths are relative with NO leading slash (e.g. \`src/utils.ts\`, not \`/src/utils.ts\`)`;

/**
 * Read a prompt from user config, falling back to the built-in default.
 */
function getPrompt(configKey: string, defaultValue: string): string {
    const config = vscode.workspace.getConfiguration('vscode-pr-azdo.prompts');
    const custom = config.get<string>(configKey, '');
    return custom.trim() || defaultValue;
}

/** Append top-level user text so Copilot Auto can route a tool-result continuation. */
export function appendAutoRoutingPrompt(messages: vscode.LanguageModelChatMessage[], prompt: string): void {
    messages.push(vscode.LanguageModelChatMessage.User(prompt));
}

/**
 * Register the @azdo-pr chat participant.
 */
export function registerPrChatParticipant(
    context: vscode.ExtensionContext,
    contextProvider: PrContextProvider,
    commentController: PrCommentController,
    log: vscode.OutputChannel,
    gitApi?: API,
    detector?: RepositoryDetector,
    reviewLensService?: ReviewLensService,
): vscode.Disposable {
    /** Resolve the git repo root, falling back to workspace folder. */
    function getRepoRoot(): vscode.Uri | undefined {
        return (detector ? getActiveRepository(gitApi, detector) : gitApi?.repositories[0])?.rootUri
            ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    }
    const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
        log.appendLine(`[chat] @azdo-pr invoked: command=${request.command ?? '(none)'}, prompt="${request.prompt.substring(0, 80)}"`);

        // Route to review handler
        if (request.command === 'review' || request.command === 'review-quick') {
            return handleReview(request, stream, token, contextProvider, commentController, log, gitApi, detector, reviewLensService);
        }

        // Route to standalone branch review (no active PR needed)
        if (request.command === 'review-branch') {
            return handleReviewBranch(request, stream, token, commentController, log, gitApi, detector);
        }

        // Build the LM messages
        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(getPrompt('fixComment', DEFAULT_SYSTEM_PROMPT)),
        ];

        // Tell the LM the workspace root so it uses absolute paths with tools
        const repoRoot = getRepoRoot();
        const wsRoot = repoRoot?.fsPath;
        if (wsRoot && !contextProvider.isSnapshotReview) {
            messages.push(vscode.LanguageModelChatMessage.User(
                `The workspace root is: ${wsRoot}\nIMPORTANT: When calling tools like copilot_readFile, use ABSOLUTE paths by prepending the workspace root. For example, to read src/index.ts, use ${wsRoot}/src/index.ts`,
            ));
        }

        // Get comment context (from button click or previous conversation)
        // Use peek (not consume) so LM tools can still access it during this handler
        const commentCtx = contextProvider.peekCommentContext();
        if (commentCtx) {
            const threadText = contextProvider.formatThreadForPrompt(commentCtx.thread);

            // Try to read the actual targeted text from the file so the LM doesn't have to count characters
            let targetedTextHint = '';
            try {
                const workspaceRoot = getRepoRoot();
                if (workspaceRoot) {
                    // Prefer the file at the original iteration commit over the working copy,
                    // since the code may have changed since the comment was made.
                    const sourceCommit = contextProvider.resolveCommentCommit(commentCtx.thread);
                    let text = '';
                    if (sourceCommit) {
                        const fileContent = await gitShowText(workspaceRoot.fsPath, sourceCommit, commentCtx.filePath);
                        if (fileContent !== undefined) {
                            const lines = fileContent.split('\n');
                            // AzDO positions are 1-based; extract the targeted range
                            const startLine = Math.max(0, commentCtx.startLine - 1);
                            const endLine = Math.max(0, commentCtx.endLine - 1);
                            const startCol = Math.max(0, commentCtx.startCol - 1);
                            const endCol = Math.max(0, commentCtx.endCol - 1);
                            if (startLine === endLine) {
                                text = (lines[startLine] ?? '').substring(startCol, endCol || undefined);
                            } else {
                                const selected = lines.slice(startLine, endLine + 1);
                                if (selected.length > 0) {
                                    selected[0] = selected[0].substring(startCol);
                                    selected[selected.length - 1] = selected[selected.length - 1].substring(0, endCol || undefined);
                                }
                                text = selected.join('\n');
                            }
                        }
                    }
                    // Fall back to working copy if original context unavailable
                    if (!text && !contextProvider.isSnapshotReview) {
                        const fileUri = vscode.Uri.joinPath(workspaceRoot, commentCtx.filePath);
                        const doc = await vscode.workspace.openTextDocument(fileUri);
                        const range = new vscode.Range(
                            Math.max(0, commentCtx.startLine - 1), Math.max(0, commentCtx.startCol - 1),
                            Math.max(0, commentCtx.endLine - 1), Math.max(0, commentCtx.endCol - 1),
                        );
                        text = doc.getText(range);
                    }
                    if (text.length > 0) {
                        const display = text.length > 100
                            ? `${text.substring(0, 50)}…${text.substring(text.length - 50)}`
                            : text;
                        targetedTextHint = `\nThe exact text being targeted is: \`${display}\``;
                    }
                }
            } catch {
                // Non-critical — skip if file can't be read
            }

            messages.push(vscode.LanguageModelChatMessage.User(
                `Here is the PR comment thread you need to resolve:\n\n${threadText}\n\nFile: ${commentCtx.filePath}, Lines: ${commentCtx.startLine}-${commentCtx.endLine}, Columns: ${commentCtx.startCol}-${commentCtx.endCol}${targetedTextHint}`,
            ));
            log.appendLine(`[chat] Using stored comment context: ${commentCtx.filePath} L${commentCtx.startLine}:${commentCtx.startCol}-L${commentCtx.endLine}:${commentCtx.endCol}${targetedTextHint ? ' (with targeted text)' : ''}`);

            // Add file reference
            const referenceCommit = contextProvider.resolveCommentCommit(commentCtx.thread);
            stream.reference(referenceCommit
                ? buildGitRefUri(commentCtx.filePath, referenceCommit)
                : vscode.Uri.file((getRepoRoot()?.fsPath ?? '') + '/' + commentCtx.filePath));
        }

        // Add PR metadata
        const prText = contextProvider.formatPrForPrompt();
        messages.push(vscode.LanguageModelChatMessage.User(
            `Here is the pull request context:\n\n${prText}`,
        ));

        // Add the user's prompt (for /fix, /explain, or freeform)
        let userInstruction: string;
        if (request.command === 'fix') {
            userInstruction = request.prompt
                ? `Resolve this PR comment. Additional context from the user: ${request.prompt}`
                : 'Resolve this PR comment. Determine if it needs a code fix, a reply, or both, and provide the appropriate response.';
        } else if (request.command === 'explain') {
            userInstruction = request.prompt
                ? `Explain what this PR comment is asking for. Additional context: ${request.prompt}`
                : 'Explain what this PR comment is asking for and what changes (if any) would be needed to address it.';
        } else {
            userInstruction = request.prompt || 'Help me with this PR comment.';
        }
        messages.push(vscode.LanguageModelChatMessage.User(userInstruction));

        // Add conversation history
        for (const turn of chatContext.history) {
            if (turn instanceof vscode.ChatRequestTurn) {
                messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
            } else if (turn instanceof vscode.ChatResponseTurn) {
                const text = turn.response
                    .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
                    .map(p => p.value.value)
                    .join('');
                if (text) {
                    messages.push(vscode.LanguageModelChatMessage.Assistant(text));
                }
            }
        }

        stream.progress('Analyzing comment…');

        try {
            // Only expose tools that work without toolInvocationToken
            const tools = getChatTools(contextProvider.isSnapshotReview);

            const response = await request.model.sendRequest(messages, {
                justification: 'Resolving a PR comment',
                tools,
                toolMode: vscode.LanguageModelChatToolMode.Auto,
            }, token);

            let fullResponseText = '';
            const MAX_TOOL_ROUNDS = 100;
            let currentResponse = response;

            for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
                const pendingToolCalls: vscode.LanguageModelToolCallPart[] = [];
                let roundText = '';

                for await (const chunk of currentResponse.stream) {
                    if (chunk instanceof vscode.LanguageModelTextPart) {
                        stream.markdown(chunk.value);
                        fullResponseText += chunk.value;
                        roundText += chunk.value;
                    } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
                        pendingToolCalls.push(chunk);
                    }
                }

                if (pendingToolCalls.length === 0) {
                    break; // No more tool calls — done
                }

                // Include any text the model already emitted so it doesn't repeat itself
                if (roundText) {
                    messages.push(vscode.LanguageModelChatMessage.Assistant(roundText));
                }

                for (const call of pendingToolCalls) {
                    log.appendLine(`[chat] Tool call (round ${round + 1}): ${call.name}(${JSON.stringify(call.input)})`);
                    stream.progress(`Using ${call.name}…`);

                    try {
                        const toolResult = await vscode.lm.invokeTool(call.name, {
                            input: call.input,
                            toolInvocationToken: undefined,
                        }, token);

                        messages.push(vscode.LanguageModelChatMessage.Assistant([call]));
                        messages.push(vscode.LanguageModelChatMessage.User([
                            new vscode.LanguageModelToolResultPart(call.callId, toolResult.content),
                        ]));
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        log.appendLine(`[chat] Tool call failed: ${msg}`);
                        messages.push(vscode.LanguageModelChatMessage.Assistant([call]));
                        messages.push(vscode.LanguageModelChatMessage.User([
                            new vscode.LanguageModelToolResultPart(call.callId, [
                                new vscode.LanguageModelTextPart(`Error: ${msg}`),
                            ]),
                        ]));
                    }
                }

                appendAutoRoutingPrompt(messages, 'Continue resolving the pull request comment using the tool results above.');
                log.appendLine(`[chat] Continuing after ${pendingToolCalls.length} tool call(s) with Auto routing context.`);

                currentResponse = await request.model.sendRequest(messages, {
                    justification: 'Continuing after tool use',
                    tools,
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                }, token);
            }

            // Offer action buttons
            if (commentCtx) {
                // Show "Apply" button if: (a) the AzDO comment has a suggestion block, OR
                // (b) the AI response contains fenced code blocks (i.e. a code fix).
                const hasAzdoSuggestion = (commentCtx.thread.comments ?? []).some(
                    c => !c.isDeleted && c.commentType !== CommentType.System && c.content && hasSuggestion(c.content),
                );
                const aiResponseHasCodeFix = /```[\w]*\n[\s\S]+?\n```/.test(fullResponseText);

                if (!contextProvider.isSnapshotReview && (hasAzdoSuggestion || aiResponseHasCodeFix)) {
                    stream.markdown('\n\n---\n');
                    stream.button({
                        command: 'vscode-pr-azdo.applySuggestion',
                        title: '✅ Apply Suggestion',
                        arguments: [],
                    });
                }

                // Extract reply draft from [REPLY]...[/REPLY] block if present
                const replyMatch = fullResponseText.match(/\[REPLY\]\s*\n?(.*?)\n?\s*\[\/REPLY\]/s);
                if (replyMatch) {
                    const replyText = replyMatch[1].trim();
                    if (replyText) {
                        stream.button({
                            command: 'vscode-pr-azdo.postAiReply',
                            title: '💬 Post Reply to Thread',
                            arguments: [commentCtx.thread.id, replyText],
                        });
                    }
                }
            }

        } catch (err) {
            if (err instanceof vscode.LanguageModelError) {
                log.appendLine(`[chat] LM error: ${err.code} — ${err.message}`);
                stream.markdown(`⚠️ Language model error: ${err.message}`);
            } else {
                const msg = err instanceof Error ? err.message : String(err);
                log.appendLine(`[chat] Error: ${msg}`);
                stream.markdown(`⚠️ Error: ${msg}`);
            }
            return { errorDetails: { message: err instanceof Error ? err.message : String(err) } };
        } finally {
            // Clear the comment context now that the handler is done
            contextProvider.consumeCommentContext();
        }

        return { metadata: {} };
    };

    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
    participant.iconPath = new vscode.ThemeIcon('git-pull-request');

    context.subscriptions.push(participant);
    log.appendLine('[chat] @azdo-pr chat participant registered');

    return participant;
}

/** Regex to parse [REVIEW_COMMENT] blocks from LM output. */
export const REVIEW_COMMENT_RE = /\[REVIEW_COMMENT\]\s*\nfile:\s*(.+)\nline:\s*(\d+)\ntype:\s*(\w+)\n---\n([\s\S]*?)\[\/REVIEW_COMMENT\]/g;

/**
 * Parse `--mode=<mode>` from the prompt string and return {mode, cleanPrompt}.
 * If no --mode flag is found, returns mode `undefined` and the original prompt.
 */
function parseReviewMode(prompt: string): { mode: ReviewMode | undefined; cleanPrompt: string } {
    const modeMatch = prompt.match(/--mode=(\S+)/);
    if (!modeMatch) {
        return { mode: undefined, cleanPrompt: prompt };
    }
    const rawMode = modeMatch[1];
    const valid: ReviewMode[] = ['staged', 'unstaged', 'all-uncommitted', 'unpushed-commits', 'vs-target'];
    const mode = valid.includes(rawMode as ReviewMode) ? (rawMode as ReviewMode) : undefined;
    const cleanPrompt = prompt.replace(/--mode=\S+/, '').trim();
    return { mode, cleanPrompt };
}

export function parseReviewArguments(prompt: string): { mode: ReviewMode | undefined; lensId: string | undefined; cleanPrompt: string } {
    const { mode, cleanPrompt: withoutMode } = parseReviewMode(prompt);
    const lensMatch = withoutMode.match(/--lens=(\S+)/);
    if (!lensMatch) {
        return { mode, lensId: undefined, cleanPrompt: withoutMode };
    }
    let lensId = lensMatch[1];
    try {
        lensId = decodeURIComponent(lensId);
    } catch {
        lensId = '';
    }
    return {
        mode,
        lensId: lensId || undefined,
        cleanPrompt: withoutMode.replace(/--lens=\S+/, '').trim(),
    };
}

/**
 * Handle /review-branch command.
 * Reviews local changes against a chosen branch — works without an active PR.
 * The target branch is passed via `request.prompt`.
 */
async function handleReviewBranch(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    commentCtrl: PrCommentController,
    log: vscode.OutputChannel,
    gitApi?: API,
    detector?: RepositoryDetector,
): Promise<vscode.ChatResult> {
    const repo = detector ? getActiveRepository(gitApi, detector) : gitApi?.repositories[0];
    if (!repo) {
        stream.markdown('No git repository found.');
        return { metadata: {} };
    }

    const currentBranch = repo.state.HEAD?.name ?? '(detached)';
    const cwd = repo.rootUri.fsPath;

    // Parse --mode=<mode> from the prompt, remainder is the target branch
    const { mode, cleanPrompt } = parseReviewMode(request.prompt);
    const reviewMode: ReviewMode = mode ?? 'vs-target';
    const targetBranch = cleanPrompt.trim() || 'main';
    const targetRef = `origin/${targetBranch}`;
    const currentBranchRef = currentBranch !== '(detached)' ? `origin/${currentBranch}` : undefined;

    const modeDesc = reviewModeLabel(reviewMode, targetBranch);
    stream.progress(`Computing diff (${modeDesc})…`);
    log.appendLine(`[chat/review-branch] mode=${reviewMode} branch=${currentBranch} target=${targetRef}`);

    let diffOutput: string;
    try {
        diffOutput = await runGitDiff(cwd, targetRef, [], reviewMode, currentBranchRef);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.appendLine(`[chat/review-branch] git diff failed: ${msg}`);
        stream.markdown(`⚠️ Failed to compute diff (${modeDesc}).\n\nMake sure the branch is fetched locally (\`git fetch origin ${targetBranch}\`).\n\n\`\`\`\n${msg}\n\`\`\``);
        return { metadata: {} };
    }

    if (!diffOutput.trim()) {
        stream.markdown(`No differences found for **${modeDesc}**. The working copy matches the target.`);
        return { metadata: {} };
    }

    stream.markdown(`Reviewing **${currentBranch}** — ${modeDesc}…\n\n`);

    const systemPrompt = getPrompt('review', DEFAULT_REVIEW_PROMPT);
    const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(systemPrompt),
    ];

    if (cwd) {
        messages.push(vscode.LanguageModelChatMessage.User(
            `The workspace root is: ${cwd}\nIMPORTANT: When calling tools like copilot_readFile, use ABSOLUTE paths by prepending the workspace root. For example, to read src/index.ts, use ${cwd}/src/index.ts`,
        ));
    }

    messages.push(vscode.LanguageModelChatMessage.User(
        `## Code Review Request\n\n` +
        `**Branch:** ${currentBranch}\n` +
        `**Review scope:** ${modeDesc}\n\n` +
        `## Diff\n\n\`\`\`diff\n${diffOutput}\n\`\`\``,
    ));

    stream.progress(`Reviewing ${modeDesc}…`);

    try {
        const tools = getChatTools();

        const response = await request.model.sendRequest(messages, {
            justification: 'Reviewing branch changes',
            tools,
            toolMode: vscode.LanguageModelChatToolMode.Auto,
        }, token);

        let fullText = '';
        const MAX_TOOL_ROUNDS = 100;
        let currentResponse = response;

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
            const pendingCalls: vscode.LanguageModelToolCallPart[] = [];
            let roundText = '';

            for await (const chunk of currentResponse.stream) {
                if (chunk instanceof vscode.LanguageModelTextPart) {
                    stream.markdown(chunk.value);
                    fullText += chunk.value;
                    roundText += chunk.value;
                } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
                    pendingCalls.push(chunk);
                }
            }

            if (pendingCalls.length === 0) {
                break;
            }

            if (roundText) {
                messages.push(vscode.LanguageModelChatMessage.Assistant(roundText));
            }

            for (const call of pendingCalls) {
                log.appendLine(`[chat/review-branch] Tool call (round ${round + 1}): ${call.name}(${JSON.stringify(call.input)})`);
                stream.progress(`Using ${call.name}…`);
                try {
                    const result = await vscode.lm.invokeTool(call.name, {
                        input: call.input,
                        toolInvocationToken: undefined,
                    }, token);
                    messages.push(vscode.LanguageModelChatMessage.Assistant([call]));
                    messages.push(vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelToolResultPart(call.callId, result.content),
                    ]));
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    messages.push(vscode.LanguageModelChatMessage.Assistant([call]));
                    messages.push(vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart(`Error: ${msg}`),
                        ]),
                    ]));
                }
            }

            appendAutoRoutingPrompt(messages, 'Continue reviewing the branch changes using the tool results above.');
            log.appendLine(`[chat/review-branch] Continuing after ${pendingCalls.length} tool call(s) with Auto routing context.`);

            currentResponse = await request.model.sendRequest(messages, {
                justification: 'Continuing review after tool use',
                tools,
                toolMode: vscode.LanguageModelChatToolMode.Auto,
            }, token);
        }

        // Parse [REVIEW_COMMENT] blocks and create draft threads
        let draftCount = 0;
        let match: RegExpExecArray | null;
        REVIEW_COMMENT_RE.lastIndex = 0;
        while ((match = REVIEW_COMMENT_RE.exec(fullText)) !== null) {
            const [, file, lineStr, type, body] = match;
            const line = parseInt(lineStr, 10);
            if (file && !isNaN(line) && body) {
                commentCtrl.createDraftThread(file.trim(), line, body.trim(), type?.trim());
                draftCount++;
            }
        }

        if (draftCount > 0) {
            stream.markdown(`\n\n---\n\n✨ Created **${draftCount}** draft comment(s) inline on files. Open the files to review them.`);
            stream.button({
                command: 'vscode-pr-azdo.clearDrafts',
                title: '🗑️ Clear All Drafts',
            });
        }

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.appendLine(`[chat/review-branch] Review error: ${msg}`);
        stream.markdown(`\n\n⚠️ Error during review: ${msg}`);
        return { errorDetails: { message: msg } };
    }

    return { metadata: {} };
}

/**
 * Handle /review and /review-quick commands.
 * Reads diffs for all changed files, asks the LM to review, and creates draft comment threads.
 */
async function handleReview(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    contextProvider: PrContextProvider,
    commentCtrl: PrCommentController,
    log: vscode.OutputChannel,
    gitApi?: API,
    detector?: RepositoryDetector,
    reviewLensService?: ReviewLensService,
): Promise<vscode.ChatResult> {
    const isQuick = request.command === 'review-quick';
    const filePaths = contextProvider.changedFilePaths;
    if (filePaths.length === 0) {
        stream.markdown('No changed files found for the active PR. Make sure you have an active pull request.');
        return { metadata: {} };
    }

    const activeRepo = detector ? getActiveRepository(gitApi, detector) : gitApi?.repositories[0];
    const workspaceRoot = activeRepo?.rootUri
        ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
        stream.markdown('No workspace root found.');
        return { metadata: {} };
    }

    // Parse --mode=<mode> from the prompt
    const { mode, lensId, cleanPrompt: extraInstructions } = parseReviewArguments(request.prompt);
    const reviewMode: ReviewMode = contextProvider.isSnapshotReview ? 'vs-target' : (mode ?? 'vs-target');

    // Get the diff against the target branch
    const pr = contextProvider.activePr;
    const targetBranch = pr?.targetRefName?.replace(/^refs\/heads\//, '') ?? 'main';
    if (contextProvider.isSnapshotReview && (!contextProvider.sourceRef || !contextProvider.targetRef)) {
        stream.markdown('The no-checkout review snapshot is incomplete. Refresh the active pull request and try again.');
        return { metadata: {} };
    }
    const targetRef = contextProvider.targetRef ?? `origin/${targetBranch}`;
    const sourceRef = contextProvider.isSnapshotReview ? contextProvider.sourceRef : undefined;
    const cwd = workspaceRoot.fsPath;
    const currentBranch = activeRepo?.state.HEAD?.name;
    const currentBranchRef = currentBranch ? `origin/${currentBranch}` : undefined;

    // For non-target modes, don't scope to PR files (review all dirty/uncommitted files)
    const diffFilePaths = reviewMode === 'vs-target' ? filePaths : [];
    const modeDesc = reviewModeLabel(reviewMode, targetBranch);

    stream.progress(`Computing diff (${modeDesc})…`);
    log.appendLine(`[chat/review] mode=${reviewMode} target=${targetRef} files=${diffFilePaths.length}`);

    let diffOutput: string;
    try {
        diffOutput = await runGitDiff(cwd, targetRef, diffFilePaths, reviewMode, currentBranchRef, sourceRef);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.appendLine(`[chat/review] git diff failed: ${msg}`);
        stream.markdown(`⚠️ Failed to compute diff (${modeDesc}): ${msg}\n\nMake sure \`${targetRef}\` is fetched locally.`);
        return { metadata: {} };
    }

    if (!diffOutput.trim()) {
        stream.markdown(`No differences found for **${modeDesc}**.`);
        return { metadata: {} };
    }

    const prText = contextProvider.formatPrForPrompt();
    const requestedLens = isQuick ? undefined : await reviewLensService?.resolveLens(lensId);
    if (!isQuick && lensId && !requestedLens) {
        stream.markdown(`Review lens **${lensId}** is unavailable; using **General**.\n\n`);
    }
    const systemPrompt = isQuick
        ? getPrompt('reviewQuick', DEFAULT_REVIEW_QUICK_PROMPT)
        : buildReviewPrompt(requestedLens ?? getBuiltInReviewLens(lensId) ?? getBuiltInReviewLens('general')!);

    const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(systemPrompt),
    ];

    // Tell the LM the workspace root so it uses absolute paths with tools
    if (cwd && !contextProvider.isSnapshotReview) {
        messages.push(vscode.LanguageModelChatMessage.User(
            `The workspace root is: ${cwd}\nIMPORTANT: When calling tools like copilot_readFile, use ABSOLUTE paths by prepending the workspace root. For example, to read src/index.ts, use ${cwd}/src/index.ts`,
        ));
    }

    if (contextProvider.isSnapshotReview) {
        messages.push(vscode.LanguageModelChatMessage.User(
            'This pull request is being reviewed without checkout. The supplied diff and vscode-pr-azdo snapshot tools read the exact PR source commit. Do not use workspace file tools because the current working tree is unrelated to this pull request.',
        ));
    }

    messages.push(vscode.LanguageModelChatMessage.User(`${prText}\n\n## Diff — ${modeDesc}\n\n\`\`\`diff\n${diffOutput}\n\`\`\``));
    if (extraInstructions) {
        messages.push(vscode.LanguageModelChatMessage.User(`Additional instructions from the reviewer: ${extraInstructions}`));
    }

    stream.progress(isQuick ? 'Summarizing changes…' : `Reviewing ${modeDesc}…`);
    log.appendLine(`[chat] /review${isQuick ? '-quick' : ''}: mode=${reviewMode} ${diffFilePaths.length || 'all'} files`);

    try {
        // Only expose tools that work without toolInvocationToken
        const tools = getChatTools(contextProvider.isSnapshotReview);

        const response = await request.model.sendRequest(messages, {
            justification: 'Reviewing PR changes',
            tools,
            toolMode: vscode.LanguageModelChatToolMode.Auto,
        }, token);

        let fullText = '';
        const MAX_TOOL_ROUNDS = 100;
        let currentResponse = response;

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
            const pendingCalls: vscode.LanguageModelToolCallPart[] = [];
            let roundText = '';

            for await (const chunk of currentResponse.stream) {
                if (chunk instanceof vscode.LanguageModelTextPart) {
                    stream.markdown(chunk.value);
                    fullText += chunk.value;
                    roundText += chunk.value;
                } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
                    pendingCalls.push(chunk);
                }
            }

            if (pendingCalls.length === 0) {
                break;
            }

            // Include any text the model already emitted so it doesn't repeat itself
            if (roundText) {
                messages.push(vscode.LanguageModelChatMessage.Assistant(roundText));
            }

            for (const call of pendingCalls) {
                log.appendLine(`[chat/review] Tool call (round ${round + 1}): ${call.name}(${JSON.stringify(call.input)})`);
                stream.progress(`Using ${call.name}…`);
                try {
                    const result = await vscode.lm.invokeTool(call.name, {
                        input: call.input,
                        toolInvocationToken: undefined,
                    }, token);
                    messages.push(vscode.LanguageModelChatMessage.Assistant([call]));
                    messages.push(vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelToolResultPart(call.callId, result.content),
                    ]));
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    messages.push(vscode.LanguageModelChatMessage.Assistant([call]));
                    messages.push(vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart(`Error: ${msg}`),
                        ]),
                    ]));
                }
            }

            appendAutoRoutingPrompt(messages, 'Continue reviewing the pull request changes using the tool results above.');
            log.appendLine(`[chat/review] Continuing after ${pendingCalls.length} tool call(s) with Auto routing context.`);

            currentResponse = await request.model.sendRequest(messages, {
                justification: 'Continuing review after tool use',
                tools,
                toolMode: vscode.LanguageModelChatToolMode.Auto,
            }, token);
        }

        // For full review, parse [REVIEW_COMMENT] blocks and create draft threads
        if (!isQuick) {
            let draftCount = 0;
            let match: RegExpExecArray | null;
            REVIEW_COMMENT_RE.lastIndex = 0;
            while ((match = REVIEW_COMMENT_RE.exec(fullText)) !== null) {
                const [, file, lineStr, type, body] = match;
                const line = parseInt(lineStr, 10);
                if (file && !isNaN(line) && body) {
                    commentCtrl.createDraftThread(file.trim(), line, body.trim(), type?.trim());
                    draftCount++;
                }
            }

            if (draftCount > 0) {
                stream.markdown(`\n\n---\n\n✨ Created **${draftCount}** draft comment(s) inline on files. Open the files to review and post them.`);
                stream.button({
                    command: 'vscode-pr-azdo.clearDrafts',
                    title: '🗑️ Clear All Drafts',
                });
            }
        }

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.appendLine(`[chat] Review error: ${msg}`);
        stream.markdown(`\n\n⚠️ Error during review: ${msg}`);
        return { errorDetails: { message: msg } };
    }

    return { metadata: {} };
}

/**
 * Run `git diff` with arguments determined by the review mode.
 * Falls back to the legacy `targetRef + filePaths` signature when no mode is given.
 */
export function runGitDiff(
    cwd: string,
    targetRef: string,
    filePaths: string[],
    mode?: ReviewMode,
    currentBranchRef?: string,
    sourceRef?: string,
): Promise<string> {
    const args = buildReviewDiffArgs(targetRef, filePaths, mode, currentBranchRef, sourceRef);

    return new Promise((resolve, reject) => {
        execFile(
            'git',
            args,
            { cwd, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' },
            (err, stdout) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(stdout);
                }
            },
        );
    });
}

export function buildReviewDiffArgs(
    targetRef: string,
    filePaths: string[],
    mode?: ReviewMode,
    currentBranchRef?: string,
    sourceRef?: string,
): string[] {
    return sourceRef
        ? ['diff', targetRef, sourceRef, '--', ...filePaths]
        : mode
            ? buildGitDiffArgs(mode, targetRef, currentBranchRef, filePaths)
            : (filePaths.length > 0
                ? ['diff', targetRef, '--', ...filePaths]
                : ['diff', targetRef]);
}

/**
 * Run `git show <ref>:<path>` to get file content at a specific commit.
 * Returns undefined if the file doesn't exist at that ref.
 */
function gitShowText(cwd: string, ref: string, filePath: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        execFile(
            'git',
            ['show', `${ref}:${filePath}`],
            { cwd, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' },
            (err, stdout) => {
                if (err) {
                    resolve(undefined);
                } else {
                    resolve(stdout);
                }
            },
        );
    });
}
