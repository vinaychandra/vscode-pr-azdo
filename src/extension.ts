import * as vscode from 'vscode';
import { getGitAPI } from './git/gitExtension';
import { RepositoryDetector } from './azdo/repositoryDetector';
import { EntraIdAuthProvider } from './azdo/auth/entraIdAuthProvider';
import { AzDoApiClient } from './azdo/apiClient';
import { PullRequestService } from './azdo/prService';
import { PrTreeDataProvider, type PrTreeItem } from './views/prTreeDataProvider';
import { ActivePrTreeDataProvider } from './views/activePrTreeDataProvider';
import type { ActivePrTreeItem } from './views/activePrTreeItems';
import { PrDetailPanel } from './views/prDetailPanel';
import { PrCommentController } from './views/prCommentController';
import { PullRequestStatus, type GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';

const OUTPUT_CHANNEL_NAME = 'Azure DevOps PR';

export async function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	context.subscriptions.push(outputChannel);

	outputChannel.appendLine('Azure DevOps PR extension activating…');

	const gitApi = await getGitAPI(outputChannel);
	if (!gitApi) {
		outputChannel.appendLine('Git extension not available — aborting activation.');
		return;
	}

	const detector = new RepositoryDetector(gitApi, outputChannel);
	context.subscriptions.push(detector);

	// React to detection changes (initial + future repo opens)
	context.subscriptions.push(
		detector.onDidChange(info => {
			void vscode.commands.executeCommand(
				'setContext',
				'vscode-pr-azdo:hasAzDoRepo',
				!!info,
			);

			if (info) {
				outputChannel.appendLine(
					`Detected Azure DevOps repo: org=${info.organization}, project=${info.project}, repo=${info.repositoryName} (remote: ${info.remoteName})`,
				);
			} else {
				outputChannel.appendLine('No Azure DevOps remote detected.');
			}
		}),
	);

	// Set the initial context key based on current state
	void vscode.commands.executeCommand(
		'setContext',
		'vscode-pr-azdo:hasAzDoRepo',
		!!detector.currentRemoteInfo,
	);

	if (detector.currentRemoteInfo) {
		const info = detector.currentRemoteInfo;
		outputChannel.appendLine(
			`Detected Azure DevOps repo: org=${info.organization}, project=${info.project}, repo=${info.repositoryName} (remote: ${info.remoteName})`,
		);
	} else {
		outputChannel.appendLine('No Azure DevOps remote detected in current repositories.');
	}

	// Debug command — invoke via Command Palette: "Azure DevOps PR: Show Detection Status"
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.showDetectionStatus', () => {
			const info = detector.currentRemoteInfo;
			if (info) {
				vscode.window.showInformationMessage(
					`AzDO detected: org=${info.organization}, project=${info.project}, repo=${info.repositoryName}`,
				);
			} else {
				vscode.window.showWarningMessage('No Azure DevOps remote detected.');
			}
		}),
	);

	// --- Auth & API ---
	const authProvider = new EntraIdAuthProvider(outputChannel);
	context.subscriptions.push(authProvider);

	let apiClient: AzDoApiClient | undefined;
	let prService: PullRequestService | undefined;
	let treeProvider: PrTreeDataProvider | undefined;
	let treeProviderSub: vscode.Disposable | undefined;
	let activePrProvider: ActivePrTreeDataProvider | undefined;
	let activePrProviderSub: vscode.Disposable | undefined;
	let activePrCommentSub: vscode.Disposable | undefined;

	// Inline comment controller — lives for the extension's lifetime
	const commentController = new PrCommentController(outputChannel);
	context.subscriptions.push(commentController);

	// Stable emitters that the tree views subscribe to once.
	const proxyEmitter = new vscode.EventEmitter<void>();
	context.subscriptions.push(proxyEmitter);
	const activePrProxyEmitter = new vscode.EventEmitter<void>();
	context.subscriptions.push(activePrProxyEmitter);

	function rebuildApiClient(): void {
		outputChannel.appendLine('[ext] rebuildApiClient called');

		// Tear down previous provider subscriptions
		treeProviderSub?.dispose();
		treeProviderSub = undefined;
		activePrProviderSub?.dispose();
		activePrProviderSub = undefined;
		activePrCommentSub?.dispose();
		activePrCommentSub = undefined;

		apiClient?.dispose();
		apiClient = undefined;
		prService = undefined;
		treeProvider?.dispose();
		treeProvider = undefined;
		activePrProvider?.dispose();
		activePrProvider = undefined;

		const info = detector.currentRemoteInfo;
		if (info) {
			outputChannel.appendLine(`[ext] Building API client for ${info.organization}/${info.project}/${info.repositoryName}`);
			apiClient = new AzDoApiClient(authProvider, info, outputChannel);
			context.subscriptions.push(apiClient);

			prService = new PullRequestService(apiClient, info);
			treeProvider = new PrTreeDataProvider(prService, apiClient, outputChannel);
			context.subscriptions.push(treeProvider);

			activePrProvider = new ActivePrTreeDataProvider(prService, gitApi!, outputChannel);
			context.subscriptions.push(activePrProvider);

			// Forward real provider's change events through stable proxy emitters
			treeProviderSub = treeProvider.onDidChangeTreeData(() => {
				proxyEmitter.fire();
			});
			activePrProviderSub = activePrProvider.onDidChangeTreeData(() => {
				void vscode.commands.executeCommand(
					'setContext', 'vscode-pr-azdo:hasActivePr', !!activePrProvider?._activePrForContext,
				);
				activePrProxyEmitter.fire();
			});
			// Update inline comments only after threads are actually loaded
			activePrCommentSub = activePrProvider.onDidUpdateComments(() => {
				commentController.updateThreads(activePrProvider?.filteredThreads);
			});
		} else {
			outputChannel.appendLine('[ext] No remote info — tree providers not created');
		}

		// Tell both tree views to re-query
		proxyEmitter.fire();
		activePrProxyEmitter.fire();
		void vscode.commands.executeCommand('setContext', 'vscode-pr-azdo:hasActivePr', false);
		commentController.updateThreads(undefined); // Clear inline comments
	}

	// Build API client when repo info changes
	context.subscriptions.push(
		detector.onDidChange(() => rebuildApiClient()),
	);
	rebuildApiClient();

	// --- Tree view ---
	outputChannel.appendLine('[ext] Creating tree view azdo-pr.pullRequests');
	const treeView = vscode.window.createTreeView<PrTreeItem>('azdo-pr.pullRequests', {
		treeDataProvider: {
			onDidChangeTreeData: proxyEmitter.event,
			getTreeItem(element: PrTreeItem) {
				return treeProvider?.getTreeItem(element) ?? new vscode.TreeItem('');
			},
			getChildren(element?: PrTreeItem) {
				outputChannel.appendLine(`[ext] getChildren called, treeProvider=${treeProvider ? 'yes' : 'NO'}, element=${element ? 'child' : 'root'}`);
				return treeProvider?.getChildren(element) ?? Promise.resolve([]);
			},
		},
		showCollapseAll: true,
	});
	context.subscriptions.push(treeView);

	// Refresh command
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.refreshPullRequests', () => {
			treeProvider?.refresh();
		}),
	);

	// --- Active PR tree view ---
	const activePrTreeView = vscode.window.createTreeView<ActivePrTreeItem>('azdo-pr.activePr', {
		treeDataProvider: {
			onDidChangeTreeData: activePrProxyEmitter.event,
			getTreeItem(element: ActivePrTreeItem) {
				return activePrProvider?.getTreeItem(element) ?? new vscode.TreeItem('');
			},
			getChildren(element?: ActivePrTreeItem) {
				return activePrProvider?.getChildren(element) ?? Promise.resolve([]);
			},
		},
		showCollapseAll: true,
	});
	context.subscriptions.push(activePrTreeView);

	// Refresh active PR command
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.refreshActivePr', () => {
			activePrProvider?.refresh();
		}),
	);

	// Filter comments in active PR view
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.filterComments', async () => {
			if (!activePrProvider) { return; }
			const current = activePrProvider.commentFilter;
			const items: vscode.QuickPickItem[] = [
				{ label: '$(comment) Active Comments', description: 'Show only active/pending threads', detail: current === 'active' ? '(current)' : undefined },
				{ label: '$(comment-discussion) All Comments', description: 'Show all threads including resolved', detail: current === 'all' ? '(current)' : undefined },
				{ label: '$(eye-closed) Hide Comments', description: 'Hide all comment threads', detail: current === 'hidden' ? '(current)' : undefined },
			];
			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: 'Filter comment threads',
			});
			if (!picked) { return; }
			const filterMap: Record<string, 'active' | 'all' | 'hidden'> = {
				'$(comment) Active Comments': 'active',
				'$(comment-discussion) All Comments': 'all',
				'$(eye-closed) Hide Comments': 'hidden',
			};
			const filter = filterMap[picked.label];
			if (filter) {
				activePrProvider.setCommentFilter(filter);
				outputChannel.appendLine(`[ext] Comment filter set to: ${filter}`);
			}
		}),
	);

	// Open PR detail webview
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.openPullRequest', (pr: GitPullRequest) => {
			if (!apiClient || !detector.currentRemoteInfo) {
				vscode.window.showWarningMessage('Not connected to Azure DevOps.');
				return;
			}
			PrDetailPanel.createOrShow(pr, context.extensionUri, apiClient, detector.currentRemoteInfo, outputChannel);
		}),
	);

	// Checkout PR source branch
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.checkoutPullRequest', async (item: unknown) => {
			// item comes from the tree view inline button — it's a PullRequestTreeItem
			const pr: GitPullRequest | undefined = (item as any)?.pr;
			if (!pr?.sourceRefName) {
				vscode.window.showWarningMessage('No source branch information available.');
				return;
			}
			const branchName = pr.sourceRefName.replace(/^refs\/heads\//, '');
			const repo = gitApi?.repositories[0];
			if (!repo) {
				vscode.window.showWarningMessage('No git repository found.');
				return;
			}
			outputChannel.appendLine(`[checkout] Fetching and checking out branch: ${branchName}`);
			try {
				// Fetch first so the remote branch is available locally
				await repo.fetch();
				await repo.checkout(branchName);
				outputChannel.appendLine(`[checkout] Successfully checked out ${branchName}`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				outputChannel.appendLine(`[checkout] Failed: ${msg}`);
				vscode.window.showErrorMessage(`Failed to checkout branch: ${msg}`);
			}
		}),
	);

	// Sign-in command
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.signIn', async () => {
			const token = await authProvider.getToken();
			if (token) {
				void vscode.commands.executeCommand(
					'setContext', 'vscode-pr-azdo:isAuthenticated', true,
				);
				vscode.window.showInformationMessage('Azure DevOps PR: Signed in successfully.');
				outputChannel.appendLine('[ext] Sign-in succeeded — refreshing tree');
				treeProvider?.refresh();
			} else {
				vscode.window.showWarningMessage('Azure DevOps PR: Sign-in was cancelled or failed.');
			}
		}),
	);

	// Check for existing session silently on startup
	const alreadyAuthenticated = await authProvider.isAuthenticated();
	void vscode.commands.executeCommand(
		'setContext', 'vscode-pr-azdo:isAuthenticated', alreadyAuthenticated,
	);
	if (alreadyAuthenticated) {
		outputChannel.appendLine('Already authenticated (existing session reused).');
	}

	// Verify API command — fetches repository info + open PRs
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.verifyApi', async () => {
			const info = detector.currentRemoteInfo;
			if (!info) {
				vscode.window.showWarningMessage('No Azure DevOps remote detected.');
				return;
			}
			if (!apiClient) {
				vscode.window.showWarningMessage('API client not available.');
				return;
			}

			try {
				outputChannel.appendLine('[verify] Fetching repository details…');
				const gitApi = await apiClient.getGitApi();

				const repo = await gitApi.getRepository(info.repositoryName, info.project);
				outputChannel.appendLine(`[verify] Repository: ${repo.name} (id: ${repo.id})`);
				outputChannel.appendLine(`[verify]   Default branch: ${repo.defaultBranch}`);
				outputChannel.appendLine(`[verify]   Web URL: ${repo.remoteUrl}`);
				outputChannel.appendLine(`[verify]   Project: ${repo.project?.name}`);

				outputChannel.appendLine('[verify] Fetching open pull requests…');
				const prs = await gitApi.getPullRequests(
					info.repositoryName,
					{ status: PullRequestStatus.Active },
					info.project,
				);

				outputChannel.appendLine(`[verify] Found ${prs.length} active pull request(s):`);
				for (const pr of prs) {
					outputChannel.appendLine(
						`[verify]   #${pr.pullRequestId}: ${pr.title} (${pr.createdBy?.displayName}) [${pr.sourceRefName} → ${pr.targetRefName}]`,
					);
				}

				outputChannel.show();
				vscode.window.showInformationMessage(
					`Found repo "${repo.name}" with ${prs.length} active PR(s). See Output panel for details.`,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				outputChannel.appendLine(`[verify] ERROR: ${msg}`);
				outputChannel.show();
				vscode.window.showErrorMessage(`API verification failed: ${msg}`);
			}
		}),
	);
}

export function deactivate() { }
