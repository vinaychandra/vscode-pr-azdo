import * as vscode from 'vscode';
import type { PrContextProvider } from './prContextProvider';
import { CommentType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { API } from '../typings/git';

/**
 * Register custom LM tools that provide PR-specific context to the language model.
 */
export function registerPrTools(
    context: vscode.ExtensionContext,
    contextProvider: PrContextProvider,
    log: vscode.OutputChannel,
    gitApi?: API,
): void {
    // --- Tool: getCommentThread ---
    context.subscriptions.push(
        vscode.lm.registerTool('vscode-pr-azdo_getCommentThread', {
            async invoke(_options, _token) {
                const ctx = contextProvider.peekCommentContext();
                if (!ctx) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('No active comment context. Click the $(sparkle) button on a comment thread first.'),
                    ]);
                }

                const text = contextProvider.formatThreadForPrompt(ctx.thread);
                log.appendLine(`[tool] getCommentThread: returning ${ctx.thread.comments?.length ?? 0} comments for ${ctx.filePath}`);
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(text),
                ]);
            },
        }),
    );

    // --- Tool: getPrInfo ---
    context.subscriptions.push(
        vscode.lm.registerTool('vscode-pr-azdo_getPrInfo', {
            async invoke(_options, _token) {
                const text = contextProvider.formatPrForPrompt();
                log.appendLine(`[tool] getPrInfo: PR=${contextProvider.activePr?.pullRequestId ?? 'none'}`);
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(text),
                ]);
            },
        }),
    );

    // --- Tool: getCodeAtComment ---
    context.subscriptions.push(
        vscode.lm.registerTool('vscode-pr-azdo_getCodeAtComment', {
            async invoke(options: vscode.LanguageModelToolInvocationOptions<{ extraLines?: number }>, _token) {
                const ctx = contextProvider.peekCommentContext();
                if (!ctx) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('No active comment context.'),
                    ]);
                }

                const extra = options.input.extraLines ?? 20;
                const workspaceRoot = gitApi?.repositories[0]?.rootUri
                    ?? vscode.workspace.workspaceFolders?.[0]?.uri;
                if (!workspaceRoot) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('No workspace root.'),
                    ]);
                }

                const fileUri = vscode.Uri.joinPath(workspaceRoot, ctx.filePath);
                try {
                    const doc = await vscode.workspace.openTextDocument(fileUri);
                    const startLine = Math.max(0, ctx.startLine - 1 - extra);
                    const endLine = Math.min(doc.lineCount - 1, ctx.endLine - 1 + extra);

                    const lines: string[] = [];
                    for (let i = startLine; i <= endLine; i++) {
                        const prefix = (i >= ctx.startLine - 1 && i <= ctx.endLine - 1) ? '>>>' : '   ';
                        lines.push(`${prefix} ${i + 1}: ${doc.lineAt(i).text}`);
                    }

                    const header = `File: ${ctx.filePath} (lines ${startLine + 1}-${endLine + 1}, comment on lines ${ctx.startLine}-${ctx.endLine})`;
                    log.appendLine(`[tool] getCodeAtComment: ${header}`);
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`${header}\n\n${lines.join('\n')}`),
                    ]);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    log.appendLine(`[tool] getCodeAtComment: error reading ${ctx.filePath}: ${msg}`);
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Error reading file: ${msg}`),
                    ]);
                }
            },
        }),
    );

    log.appendLine('[tools] Registered 3 PR-specific LM tools');
}
