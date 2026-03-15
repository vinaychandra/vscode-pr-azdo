import * as vscode from 'vscode';
import type { PrContextProvider } from './prContextProvider';
import { hasSuggestion, extractSuggestion } from '../views/suggestionRenderer';
import { CommentType } from 'azure-devops-node-api/interfaces/GitInterfaces';

const PARTICIPANT_ID = 'vscode-pr-azdo.pr-assistant';

const SYSTEM_PROMPT = `You are an AI assistant integrated into a VS Code extension for Azure DevOps pull request reviews.

Your job is to help the developer resolve PR comments. You will be given:
- The comment thread (all comments and their authors)
- The file and line range where the comment was made
- The code at that location
- PR metadata (title, description, branches, changed files)

You have access to the full workspace. Use the available tools to read files, search for symbols, and understand the codebase when needed. Do NOT guess about code structure — look it up.

Based on the comment, decide what action to take:

1. **Code fix needed** — If the comment asks for a code change:
   - Explain what needs to change and why
   - Provide the exact fixed code in a fenced code block with the language identifier
   - The code block should contain the complete replacement for the affected lines
   - Reference the file path so the user can apply the fix

2. **Answer/explanation needed** — If the comment asks a question or needs a text response:
   - Draft a clear, concise reply
   - IMPORTANT: Wrap the reply text in a REPLY block like this:
     [REPLY]
     Your reply text here
     [/REPLY]
   - If relevant, reference specific code or files to support the answer

3. **Both** — If the comment needs both a code change and a response:
   - Provide the code fix first, then the reply draft in a [REPLY] block

Be direct and practical. Don't add unnecessary caveats. Write as if you're a team member responding to the comment.`;

/**
 * Register the @azdo-pr chat participant.
 */
export function registerPrChatParticipant(
    context: vscode.ExtensionContext,
    contextProvider: PrContextProvider,
    log: vscode.OutputChannel,
): vscode.Disposable {
    const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
        log.appendLine(`[chat] @azdo-pr invoked: command=${request.command ?? '(none)'}, prompt="${request.prompt.substring(0, 80)}"`);

        // Build the LM messages
        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
        ];

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
                    const fileUri = vscode.Uri.joinPath(workspaceRoot, commentCtx.filePath);
                    const doc = await vscode.workspace.openTextDocument(fileUri);
                    const startLine = Math.max(0, commentCtx.startLine - 1);
                    const endLine = Math.max(0, commentCtx.endLine - 1);
                    const startCol = Math.max(0, commentCtx.startCol - 1);
                    const endCol = Math.max(0, commentCtx.endCol - 1);
                    const range = new vscode.Range(startLine, startCol, endLine, endCol);
                    const text = doc.getText(range);
                    if (text.length > 0) {
                        // Show the targeted text, truncated if long
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
            // Get available tools for the LM to use
            const tools = vscode.lm.tools
                .filter(t => t.name.startsWith('vscode-pr-azdo_') || t.tags.includes('workspace'))
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
