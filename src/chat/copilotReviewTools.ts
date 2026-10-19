import * as vscode from 'vscode';
import type { CopilotReviewService, ReviewFinding, ReviewStartOptions } from './copilotReview';

export function registerCopilotReviewTools(
    context: vscode.ExtensionContext,
    service: CopilotReviewService,
    log: vscode.OutputChannel,
): void {
    function register<T>(name: string, invoke: (input: T, token: vscode.CancellationToken) => Promise<object> | object): void {
        context.subscriptions.push(vscode.lm.registerTool<T>(`vscode-pr-azdo_${name}`, {
            async invoke(options, token) {
                try {
                    const result = await invoke(options.input, token);
                    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result))]);
                } catch (error) {
                    log.appendLine(`[copilot/tool] ${name}: ${error instanceof Error ? error.message : String(error)}`);
                    throw error;
                }
            },
        }));
    }

    register<{ runId?: string } & Pick<ReviewStartOptions, 'kind' | 'mode' | 'lensId'>>(
        'getReviewContext', (input, token) => service.context(input.runId, token, input));
    register<{
        runId: string; path: string; view?: 'source' | 'base' | 'diff' | 'comment' | 'checkout';
        startLine?: number; endLine?: number;
    }>('readReviewFile', (input, token) => service.read(
        input.runId, input.path, input.view ?? 'source', input.startLine ?? 1, input.endLine ?? 300, token,
    ));
    register<{ runId: string; directory?: string; offset?: number }>('listReviewFiles', (input, token) =>
        service.list(input.runId, input.directory ?? '', input.offset ?? 0, token));
    register<{ runId: string; query: string; paths?: string[]; offset?: number }>('searchReviewFiles', (input, token) =>
        service.search(input.runId, input.query, input.paths, token, input.offset));
    register<{ runId: string; findings: ReviewFinding[] }>('createReviewDrafts', (input, token) =>
        service.createDrafts(input.runId, input.findings, token));
    register<{ runId: string; body: string }>('draftReviewReply', (input, token) =>
        service.draftReply(input.runId, input.body, token));
    register<{ runId: string; path: string; original: string; replacement: string }>('proposeReviewFix', async (input, token) => {
        const proposal = await service.proposeFix(input.runId, input.path, input.original, input.replacement, token);
        void vscode.window.showInformationMessage(
            'Copilot proposed a local code fix. Preview and approve it before applying.', 'Preview AI Fix',
        ).then(action => {
            if (action === 'Preview AI Fix') { return vscode.commands.executeCommand('vscode-pr-azdo.previewAiFix', proposal.proposalId); }
            return undefined;
        }).then(undefined, error => {
            const message = error instanceof Error ? error.message : String(error);
            log.appendLine(`[copilot/fix] ${message}`);
            void vscode.window.showErrorMessage(`Could not preview the AI fix: ${message}`);
        });
        return proposal;
    });
}
