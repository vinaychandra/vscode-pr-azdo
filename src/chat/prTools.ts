import * as vscode from 'vscode';
import { execFile } from 'child_process';
import type { PrContextProvider } from './prContextProvider';
import { CommentType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { API } from '../typings/git';
import type { RepositoryDetector } from '../azdo/repositoryDetector';
import { getActiveRepository } from '../git/gitExtension';
import { buildGitRefUri } from '../views/gitRefContentProvider';

/**
 * Register custom LM tools that provide PR-specific context to the language model.
 */
export function registerPrTools(
    context: vscode.ExtensionContext,
    contextProvider: PrContextProvider,
    log: vscode.OutputChannel,
    gitApi?: API,
    detector?: RepositoryDetector,
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
                const workspaceRoot = (detector ? getActiveRepository(gitApi, detector) : gitApi?.repositories[0])?.rootUri
                    ?? vscode.workspace.workspaceFolders?.[0]?.uri;
                if (!workspaceRoot) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('No workspace root.'),
                    ]);
                }

                const commit = contextProvider.resolveCommentCommit(ctx.thread);
                const fileUri = commit
                    ? buildGitRefUri(ctx.filePath, commit)
                    : vscode.Uri.joinPath(workspaceRoot, ctx.filePath);
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

    context.subscriptions.push(
        vscode.lm.registerTool('vscode-pr-azdo_readSnapshotFile', {
            async invoke(options: vscode.LanguageModelToolInvocationOptions<{ path: string }>, _token) {
                const sourceRef = contextProvider.sourceRef;
                const filePath = normalizeSnapshotPath(options.input.path);
                if (!contextProvider.isSnapshotReview || !sourceRef || !filePath) {
                    return textResult('No active no-checkout review or invalid relative file path.');
                }
                try {
                    const doc = await vscode.workspace.openTextDocument(buildGitRefUri(filePath, sourceRef));
                    return textResult(`File: ${filePath}\n\n${doc.getText()}`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    return textResult(`Error reading PR snapshot file: ${msg}`);
                }
            },
        }),
    );

    context.subscriptions.push(
        vscode.lm.registerTool('vscode-pr-azdo_searchSnapshot', {
            async invoke(options: vscode.LanguageModelToolInvocationOptions<{ query: string; path?: string }>, _token) {
                const sourceRef = contextProvider.sourceRef;
                const repoRoot = (detector ? getActiveRepository(gitApi, detector) : gitApi?.repositories[0])?.rootUri.fsPath;
                const query = options.input.query?.trim();
                const searchPath = options.input.path ? normalizeSnapshotPath(options.input.path) : undefined;
                if (!contextProvider.isSnapshotReview || !sourceRef || !repoRoot || !query || (options.input.path && !searchPath)) {
                    return textResult('No active no-checkout review or invalid search input.');
                }
                const output = await gitGrep(repoRoot, sourceRef, query, searchPath);
                return textResult(output || 'No matches in the PR source snapshot.');
            },
        }),
    );

    log.appendLine('[tools] Registered 5 PR-specific LM tools');
}

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

function normalizeSnapshotPath(value: string | undefined): string | undefined {
    const normalized = value?.trim().replaceAll('\\', '/').replace(/^\/+/, '');
    if (!normalized || normalized.split('/').includes('..')) { return undefined; }
    return normalized;
}

function gitGrep(cwd: string, ref: string, query: string, searchPath?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const args = ['grep', '-n', '--no-color', '-I', '-e', query, ref];
        if (searchPath) { args.push('--', searchPath); }
        execFile('git', args, { cwd, encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
            if (err && (err as NodeJS.ErrnoException & { code?: number }).code !== 1) {
                reject(err);
            } else {
                resolve(stdout.slice(0, 200_000));
            }
        });
    });
}
