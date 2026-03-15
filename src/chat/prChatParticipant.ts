import * as vscode from 'vscode';
import { execFile } from 'child_process';
import type { PrContextProvider } from './prContextProvider';
import type { PrCommentController } from '../views/prCommentController';
import { hasSuggestion, extractSuggestion } from '../views/suggestionRenderer';
import { CommentType } from 'azure-devops-node-api/interfaces/GitInterfaces';

const PARTICIPANT_ID = 'vscode-pr-azdo.pr-assistant';

export const DEFAULT_REVIEW_PROMPT = `You are an expert code reviewer reviewing a pull request on Azure DevOps.

## Input
You will receive a unified diff (git diff output) of the changed files. The diff uses standard format:
- Lines starting with \`---\` and \`+++\` show the old and new file paths
- \`@@ -oldStart,oldCount +newStart,newCount @@\` marks each changed hunk
- Lines starting with \`-\` were removed, \`+\` were added, space means unchanged context
- Use the NEW file line numbers (the \`+\` side / right side of the hunk header) for your comments

## Tools
You have access to workspace tools. USE THEM before commenting:
- Look up types, interfaces, or functions referenced in the diff before flagging issues
- Check imports and dependencies to understand context
- Read related files if the diff references code you can't see
Do NOT guess about code you haven't seen — look it up first.

## Output Format
For EACH review comment, use this EXACT format:

[REVIEW_COMMENT]
file: <relative path, NO leading slash, e.g. src/utils.ts>
line: <line number in the NEW file — from the + side of the diff>
type: <suggestion|issue|nitpick|question>
---
Your review comment here.
[/REVIEW_COMMENT]

## Review Focus
Prioritize (high to low):
1. **Bugs and logic errors** — incorrect behavior, off-by-one, race conditions
2. **Security** — injection, auth issues, data exposure, unsafe input handling
3. **Error handling** — missing try/catch, unhandled promise rejections, silent failures
4. **Performance** — unnecessary allocations, O(n²) when O(n) is possible, missing caching
5. **API misuse** — wrong method signatures, deprecated APIs, incorrect types
6. **Clarity** — confusing names, missing context, code that needs a comment to understand

## Rules
- Do NOT comment on trivial style, formatting, or whitespace issues
- Be specific: reference the actual code, explain WHY something is a problem, suggest a fix
- If a change looks correct and clean, don't force a comment — it's fine to have zero comments
- When suggesting a fix, show the corrected code inline in your comment
- After all comments, provide a brief overall summary (2-3 sentences) of what the PR does and your assessment`;

export const DEFAULT_REVIEW_QUICK_PROMPT = `You are an expert code reviewer. Provide a quick, high-level review of this pull request.

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

/**
 * Register the @azdo-pr chat participant.
 */
export function registerPrChatParticipant(
    context: vscode.ExtensionContext,
    contextProvider: PrContextProvider,
    commentController: PrCommentController,
    log: vscode.OutputChannel,
): vscode.Disposable {
    const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
        log.appendLine(`[chat] @azdo-pr invoked: command=${request.command ?? '(none)'}, prompt="${request.prompt.substring(0, 80)}"`);

        // Route to review handler
        if (request.command === 'review' || request.command === 'review-quick') {
            return handleReview(request, stream, token, contextProvider, commentController, log);
        }

        // Build the LM messages
        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(getPrompt('fixComment', DEFAULT_SYSTEM_PROMPT)),
        ];

        // Tell the LM the workspace root so it uses absolute paths with tools
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (wsRoot) {
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
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
                if (workspaceRoot) {
                    // Prefer the file at the original iteration commit over the working copy,
                    // since the code may have changed since the comment was made.
                    const sourceCommit = contextProvider.resolveSourceCommit(commentCtx.thread);
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
                    if (!text) {
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
            stream.reference(vscode.Uri.file(
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath + '/' + commentCtx.filePath,
            ));
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
            // Pass all available tools so the LM can explore the workspace
            const tools = vscode.lm.tools
                .map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? {} }));

            const response = await request.model.sendRequest(messages, {
                justification: 'Resolving a PR comment',
                tools,
                toolMode: vscode.LanguageModelChatToolMode.Auto,
            }, token);

            // Process the response stream — handle tool calls and text
            const pendingToolCalls: vscode.LanguageModelToolCallPart[] = [];
            let fullResponseText = '';

            for await (const chunk of response.stream) {
                if (chunk instanceof vscode.LanguageModelTextPart) {
                    stream.markdown(chunk.value);
                    fullResponseText += chunk.value;
                } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
                    pendingToolCalls.push(chunk);
                }
            }

            // If there are tool calls, execute them and continue
            if (pendingToolCalls.length > 0) {
                for (const call of pendingToolCalls) {
                    log.appendLine(`[chat] Tool call: ${call.name}(${JSON.stringify(call.input)})`);
                    stream.progress(`Using ${call.name}…`);

                    try {
                        const toolResult = await vscode.lm.invokeTool(call.name, {
                            input: call.input,
                            toolInvocationToken: undefined,
                        }, token);

                        // Add tool result and continue conversation
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

                // Continue with tool results
                const followUp = await request.model.sendRequest(messages, {
                    justification: 'Continuing after tool use',
                    tools,
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                }, token);

                for await (const chunk of followUp.text) {
                    stream.markdown(chunk);
                    fullResponseText += chunk;
                }
            }

            // Offer action buttons
            if (commentCtx) {
                // Check if the comment contains an AzDO suggestion that can be applied directly
                const firstComment = (commentCtx.thread.comments ?? []).find(
                    c => !c.isDeleted && c.commentType !== CommentType.System && c.content && hasSuggestion(c.content),
                );
                if (firstComment?.content) {
                    const suggestion = extractSuggestion(firstComment.content);
                    if (suggestion !== undefined) {
                        stream.markdown('\n\n---\n');
                        stream.button({
                            command: 'vscode-pr-azdo.applySuggestion',
                            title: '✅ Apply Suggestion',
                            arguments: [],
                        });
                    }
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
const REVIEW_COMMENT_RE = /\[REVIEW_COMMENT\]\s*\nfile:\s*(.+)\nline:\s*(\d+)\ntype:\s*(\w+)\n---\n([\s\S]*?)\[\/REVIEW_COMMENT\]/g;

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
): Promise<vscode.ChatResult> {
    const isQuick = request.command === 'review-quick';
    const filePaths = contextProvider.changedFilePaths;
    if (filePaths.length === 0) {
        stream.markdown('No changed files found for the active PR. Make sure you have an active pull request.');
        return { metadata: {} };
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
        stream.markdown('No workspace root found.');
        return { metadata: {} };
    }

    // Get the diff against the target branch
    const pr = contextProvider.activePr;
    const targetBranch = pr?.targetRefName?.replace(/^refs\/heads\//, '') ?? 'main';
    const targetRef = `origin/${targetBranch}`;
    const cwd = workspaceRoot.fsPath;

    stream.progress(`Computing diff against ${targetBranch}…`);

    let diffOutput: string;
    try {
        diffOutput = await runGitDiff(cwd, targetRef, filePaths);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.appendLine(`[chat/review] git diff failed: ${msg}`);
        stream.markdown(`⚠️ Failed to compute diff: ${msg}\n\nMake sure \`${targetRef}\` is fetched locally.`);
        return { metadata: {} };
    }

    if (!diffOutput.trim()) {
        stream.markdown('No differences found against the target branch. The working copy matches the target.');
        return { metadata: {} };
    }

    const prText = contextProvider.formatPrForPrompt();
    const systemPrompt = isQuick
        ? getPrompt('reviewQuick', DEFAULT_REVIEW_QUICK_PROMPT)
        : getPrompt('review', DEFAULT_REVIEW_PROMPT);

    const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(systemPrompt),
    ];

    // Tell the LM the workspace root so it uses absolute paths with tools
    if (cwd) {
        messages.push(vscode.LanguageModelChatMessage.User(
            `The workspace root is: ${cwd}\nIMPORTANT: When calling tools like copilot_readFile, use ABSOLUTE paths by prepending the workspace root. For example, to read src/index.ts, use ${cwd}/src/index.ts`,
        ));
    }

    messages.push(vscode.LanguageModelChatMessage.User(`${prText}\n\n## Diff (against ${targetBranch})\n\n\`\`\`diff\n${diffOutput}\n\`\`\``));
    if (request.prompt) {
        messages.push(vscode.LanguageModelChatMessage.User(`Additional instructions from the reviewer: ${request.prompt}`));
    }

    stream.progress(isQuick ? 'Summarizing changes…' : 'Reviewing changes…');
    log.appendLine(`[chat] /review${isQuick ? '-quick' : ''}: ${filePaths.length} files`);

    try {
        // Pass all available tools so the LM can explore the workspace during review
        const tools = vscode.lm.tools
            .map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? {} }));

        const response = await request.model.sendRequest(messages, {
            justification: 'Reviewing PR changes',
            tools,
            toolMode: vscode.LanguageModelChatToolMode.Auto,
        }, token);

        let fullText = '';
        const pendingCalls: vscode.LanguageModelToolCallPart[] = [];

        for await (const chunk of response.stream) {
            if (chunk instanceof vscode.LanguageModelTextPart) {
                stream.markdown(chunk.value);
                fullText += chunk.value;
            } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
                pendingCalls.push(chunk);
            }
        }

        // Handle tool calls if the LM needs more context
        if (pendingCalls.length > 0) {
            for (const call of pendingCalls) {
                log.appendLine(`[chat/review] Tool call: ${call.name}(${JSON.stringify(call.input)})`);
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
            const followUp = await request.model.sendRequest(messages, {
                justification: 'Continuing review after tool use',
                tools,
                toolMode: vscode.LanguageModelChatToolMode.Auto,
            }, token);
            for await (const chunk of followUp.text) {
                stream.markdown(chunk);
                fullText += chunk;
            }
        }

        // For full review, parse [REVIEW_COMMENT] blocks and create draft threads
        if (!isQuick) {
            let draftCount = 0;
            let match: RegExpExecArray | null;
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
 * Run `git diff` against a target ref for the specified files.
 */
function runGitDiff(cwd: string, targetRef: string, filePaths: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            'git',
            ['diff', targetRef, '--', ...filePaths],
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
