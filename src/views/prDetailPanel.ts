import * as vscode from 'vscode';
import type { GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { PullRequestAsyncStatus, PullRequestStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { AzDoApiClient } from '../azdo/apiClient';
import type { AzDoRemoteInfo, ParsedAzDoRemote } from '../azdo/remoteInfo';

/** Messages sent from webview → extension. */
interface WebviewMessage {
    command: 'approve' | 'reject' | 'waitingForAuthor' | 'openInBrowser' | 'copyLink' | 'checkout';
}

/**
 * Webview panel showing detailed PR information with action buttons.
 */
export class PrDetailPanel {
    private static readonly viewType = 'azdoPrDetail';
    private static _panels = new Map<number, PrDetailPanel>();

    private readonly _panel: vscode.WebviewPanel;
    private _disposed = false;

    static createOrShow(
        pr: GitPullRequest,
        extensionUri: vscode.Uri,
        apiClient: AzDoApiClient,
        remoteInfo: AzDoRemoteInfo,
        log: vscode.OutputChannel,
    ): void {
        const id = pr.pullRequestId!;
        const existing = PrDetailPanel._panels.get(id);
        if (existing && !existing._disposed) {
            existing._panel.reveal();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            PrDetailPanel.viewType,
            `PR #${id}: ${pr.title ?? ''}`,
            vscode.ViewColumn.One,
            { enableScripts: true },
        );

        const instance = new PrDetailPanel(panel, pr, apiClient, remoteInfo, log);
        PrDetailPanel._panels.set(id, instance);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly pr: GitPullRequest,
        private readonly apiClient: AzDoApiClient,
        private readonly remoteInfo: AzDoRemoteInfo,
        private readonly log: vscode.OutputChannel,
    ) {
        this._panel = panel;
        this._panel.webview.html = buildHtml(pr, remoteInfo);
        this._panel.onDidDispose(() => {
            this._disposed = true;
            PrDetailPanel._panels.delete(pr.pullRequestId!);
        });
        this._panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this.handleMessage(msg));
    }

    private async handleMessage(msg: WebviewMessage): Promise<void> {
        switch (msg.command) {
            case 'approve':
                await this.castVote(10);
                break;
            case 'reject':
                await this.castVote(-10);
                break;
            case 'waitingForAuthor':
                await this.castVote(-5);
                break;
            case 'openInBrowser': {
                const url = buildPrWebUrl(this.remoteInfo, this.pr.pullRequestId!);
                void vscode.env.openExternal(vscode.Uri.parse(url));
                break;
            }
            case 'copyLink': {
                const url = buildPrWebUrl(this.remoteInfo, this.pr.pullRequestId!);
                await vscode.env.clipboard.writeText(url);
                vscode.window.showInformationMessage('PR link copied to clipboard.');
                break;
            }
            case 'checkout':
                this.log.appendLine(`[detail] Checkout requested for PR #${this.pr.pullRequestId}`);
                void vscode.commands.executeCommand('vscode-pr-azdo.checkoutPullRequest', { pr: this.pr });
                break;
        }
    }

    private async castVote(vote: number): Promise<void> {
        try {
            await this.apiClient.withAuthRecovery(async () => {
                const gitApi = await this.apiClient.getGitApi();
                const userId = await this.apiClient.getCurrentUserId();
                await gitApi.createPullRequestReviewer(
                    { vote },
                    this.remoteInfo.repositoryName,
                    this.pr.pullRequestId!,
                    userId,
                    this.remoteInfo.project,
                );
            });
            const label = vote === 10 ? 'approved' : vote === -10 ? 'rejected' : vote === -5 ? 'marked as waiting for author' : `voted (${vote})`;
            this.log.appendLine(`[pr-detail] PR #${this.pr.pullRequestId} ${label}`);
            vscode.window.showInformationMessage(`PR #${this.pr.pullRequestId} ${label}.`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.appendLine(`[pr-detail] Vote failed: ${msg}`);
            vscode.window.showErrorMessage(`Failed to submit vote: ${msg}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Pure / exported helpers
// ---------------------------------------------------------------------------

export function buildPrWebUrl(remoteInfo: ParsedAzDoRemote, prId: number): string {
    return `https://dev.azure.com/${encodeURIComponent(remoteInfo.organization)}/${encodeURIComponent(remoteInfo.project)}/_git/${encodeURIComponent(remoteInfo.repositoryName)}/pullrequest/${prId}`;
}

/**
 * Build a URL to the Azure DevOps "Create Pull Request" page.
 * @param sourceBranch Short branch name (e.g. "feature/x"), not "refs/heads/...".
 * @param targetBranch Short branch name for the target (e.g. "main").
 */
export function buildCreatePrUrl(remoteInfo: ParsedAzDoRemote, sourceBranch: string, targetBranch: string): string {
    return `https://dev.azure.com/${encodeURIComponent(remoteInfo.organization)}/${encodeURIComponent(remoteInfo.project)}/_git/${encodeURIComponent(remoteInfo.repositoryName)}/pullrequestcreate?sourceRef=${encodeURIComponent(sourceBranch)}&targetRef=${encodeURIComponent(targetBranch)}`;
}

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function voteLabel(vote: number): string {
    switch (vote) {
        case 10: return '✅ Approved';
        case 5: return '✅ Approved with suggestions';
        case 0: return '⏳ No vote';
        case -5: return '⏸️ Waiting for author';
        case -10: return '❌ Rejected';
        default: return `Vote: ${vote}`;
    }
}

export function prStatusLabel(status: PullRequestStatus | undefined): string {
    switch (status) {
        case PullRequestStatus.Active: return 'Active';
        case PullRequestStatus.Completed: return 'Completed';
        case PullRequestStatus.Abandoned: return 'Abandoned';
        default: return 'Unknown';
    }
}

export function mergeStatusLabel(status: PullRequestAsyncStatus | undefined): string {
    switch (status) {
        case PullRequestAsyncStatus.Succeeded: return '✅ Ready to merge';
        case PullRequestAsyncStatus.Conflicts: return '⚠️ Merge conflicts';
        case PullRequestAsyncStatus.RejectedByPolicy: return '🚫 Rejected by policy';
        case PullRequestAsyncStatus.Failure: return '❌ Merge failed';
        case PullRequestAsyncStatus.Queued: return '⏳ Merge queued';
        case PullRequestAsyncStatus.NotSet: return '—';
        default: return '—';
    }
}

// ---------------------------------------------------------------------------
// HTML builder (pure function for testability)
// ---------------------------------------------------------------------------

export function buildHtml(pr: GitPullRequest, remoteInfo: ParsedAzDoRemote): string {
    const shortRef = (r: string | undefined) => r?.replace(/^refs\/heads\//, '') ?? '';
    const created = pr.creationDate ? new Date(pr.creationDate).toLocaleString() : 'unknown';
    const closed = pr.closedDate ? new Date(pr.closedDate).toLocaleString() : null;
    const description = escapeHtml(pr.description ?? 'No description provided.');
    const webUrl = buildPrWebUrl(remoteInfo, pr.pullRequestId!);

    // Status badges
    const statusText = prStatusLabel(pr.status);
    const mergeText = mergeStatusLabel(pr.mergeStatus);

    // Labels
    const labelsHtml = (pr.labels ?? [])
        .filter(l => l.active !== false)
        .map(l => `<span class="label">${escapeHtml(l.name ?? '')}</span>`)
        .join(' ');

    // Auto-complete
    const autoComplete = pr.autoCompleteSetBy
        ? `Set by ${escapeHtml(pr.autoCompleteSetBy.displayName ?? 'unknown')}`
        : 'Not set';

    // Completion options
    let completionOptsHtml = '';
    if (pr.completionOptions) {
        const opts = pr.completionOptions;
        const parts: string[] = [];
        if (opts.squashMerge) { parts.push('Squash merge'); }
        if (opts.deleteSourceBranch) { parts.push('Delete source branch'); }
        if (opts.transitionWorkItems) { parts.push('Transition work items'); }
        if (parts.length > 0) {
            completionOptsHtml = parts.join(', ');
        }
    }

    // Reviewers
    const reviewerRows = (pr.reviewers ?? [])
        .map(r => {
            const vote = voteLabel(r.vote ?? 0);
            const required = r.isRequired ? ' <span class="badge badge-required">Required</span>' : '';
            const flagged = r.isFlagged ? ' 🔔' : '';
            return `<tr><td>${escapeHtml(r.displayName ?? 'unknown')}${required}${flagged}</td><td>${vote}</td></tr>`;
        })
        .join('\n');

    // Work items
    const workItemsHtml = (pr.workItemRefs ?? [])
        .map(wi => {
            const wiUrl = `https://dev.azure.com/${encodeURIComponent(remoteInfo.organization)}/${encodeURIComponent(remoteInfo.project)}/_workitems/edit/${escapeHtml(wi.id ?? '')}`;
            return `<a href="${wiUrl}" class="work-item">#${escapeHtml(wi.id ?? '')}</a>`;
        })
        .join(' ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PR #${pr.pullRequestId}</title>
<style>
  body { font-family: var(--vscode-font-family, sans-serif); padding: 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); line-height: 1.5; }
  h1 { font-size: 1.4em; margin-bottom: 4px; }
  .toolbar { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; }
  .toolbar button { padding: 6px 14px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; cursor: pointer; font-size: 0.85em; font-family: inherit; }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-danger { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-foreground); }
  .btn-danger:hover { opacity: 0.85; }
  .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .info-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; margin: 16px 0; font-size: 0.9em; }
  .info-grid dt { color: var(--vscode-descriptionForeground); font-weight: 600; }
  .info-grid dd { margin: 0; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.8em; }
  .badge-draft { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .badge-active { background: #1a7f37; color: #fff; }
  .badge-completed { background: #6f42c1; color: #fff; }
  .badge-abandoned { background: #6e7681; color: #fff; }
  .badge-required { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 0.75em; }
  .label { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.8em; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-right: 4px; }
  .description { white-space: pre-wrap; margin: 16px 0; padding: 12px; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); }
  table { border-collapse: collapse; margin-top: 8px; width: 100%; }
  th, td { text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--vscode-widget-border, #333); }
  th { color: var(--vscode-descriptionForeground); }
  .section-title { font-size: 1.1em; margin-top: 24px; margin-bottom: 8px; }
  .work-item { color: var(--vscode-textLink-foreground); text-decoration: none; margin-right: 8px; }
  .work-item:hover { text-decoration: underline; }
  code { background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
</style>
</head>
<body>
  <h1>${escapeHtml(pr.title ?? '')}</h1>

  <div class="toolbar">
    <button class="btn-primary" onclick="send('approve')">👍 Approve</button>
    <button class="btn-secondary" onclick="send('waitingForAuthor')">⏸️ Waiting for Author</button>
    <button class="btn-danger" onclick="send('reject')">👎 Reject</button>
    <button class="btn-secondary" onclick="send('openInBrowser')">🌐 Open in Browser</button>
    <button class="btn-secondary" onclick="send('copyLink')">📋 Copy Link</button>
    <button class="btn-secondary" onclick="send('checkout')">📥 Checkout Branch</button>
  </div>

  <dl class="info-grid">
    <dt>PR</dt>
    <dd>#${pr.pullRequestId}</dd>

    <dt>Author</dt>
    <dd>${escapeHtml(pr.createdBy?.displayName ?? 'unknown')}</dd>

    <dt>Status</dt>
    <dd><span class="badge badge-${statusText.toLowerCase()}">${statusText}</span>${pr.isDraft ? ' <span class="badge badge-draft">Draft</span>' : ''}</dd>

    <dt>Branches</dt>
    <dd><code>${escapeHtml(shortRef(pr.sourceRefName))}</code> → <code>${escapeHtml(shortRef(pr.targetRefName))}</code></dd>

    <dt>Merge Status</dt>
    <dd>${mergeText}</dd>

    <dt>Created</dt>
    <dd>${created}</dd>

    ${closed ? `<dt>Closed</dt><dd>${closed}</dd>` : ''}

    <dt>Auto-complete</dt>
    <dd>${autoComplete}${completionOptsHtml ? ` (${completionOptsHtml})` : ''}</dd>

    ${labelsHtml ? `<dt>Labels</dt><dd>${labelsHtml}</dd>` : ''}

    ${workItemsHtml ? `<dt>Work Items</dt><dd>${workItemsHtml}</dd>` : ''}
  </dl>

  <div class="section-title">Description</div>
  <div class="description">${description}</div>

  ${(pr.reviewers?.length ?? 0) > 0 ? `
  <div class="section-title">Reviewers</div>
  <table>
    <tr><th>Name</th><th>Vote</th></tr>
    ${reviewerRows}
  </table>` : ''}

  <script>
    const vscode = acquireVsCodeApi();
    function send(command) { vscode.postMessage({ command }); }
  </script>
</body>
</html>`;
}
