import * as vscode from 'vscode';
import { getGitAPI, getActiveRepository, deleteLocalBranch, getCommitLog, gitCommitAll, gitStash, isBranchInSyncWithRemote, getBranchAheadBehind, fastForwardToUpstream, resetBranchToUpstream } from './git/gitExtension';
import { RepositoryDetector } from './azdo/repositoryDetector';
import { EntraIdAuthProvider } from './azdo/auth/entraIdAuthProvider';
import { AzDoApiClient, TenantMismatchError } from './azdo/apiClient';
import { PullRequestService } from './azdo/prService';
import { PrTreeDataProvider, type PrTreeItem } from './views/prTreeDataProvider';
import { PullRequestTreeItem } from './views/prTreeItems';
import { ActivePrTreeDataProvider } from './views/activePrTreeDataProvider';
import { FileChangeItem, FolderItem, ActivePrRootItem, SectionHeaderItem, type ActivePrTreeItem } from './views/activePrTreeItems';
import { PrDetailPanel, buildCreatePrUrl, buildPrWebUrl } from './views/prDetailPanel';
import { PrCommentController, PR_COMMENTS_SCHEME, type PersistedDrafts } from './views/prCommentController';
import { GitRefContentProvider, GIT_CONTENT_SCHEME, buildGitRefUri } from './views/gitRefContentProvider';
import { computeRelativePath, extractPathFromGitRefUri, getWorkspaceFileUriFromDiffInput, isUriInChangedFiles, buildDiffParams } from './views/toggleFileDiffHelpers';
import { VersionControlChangeType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { PullRequestStatus, CommentThreadStatus, type GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { PrContextProvider } from './chat/prContextProvider';
import { registerPrChatParticipant, DEFAULT_SYSTEM_PROMPT, DEFAULT_REVIEW_PROMPT, DEFAULT_REVIEW_QUICK_PROMPT, runGitDiff } from './chat/prChatParticipant';
import { registerPrTools } from './chat/prTools';
import { detectGitState, getReviewOptions, type ReviewQuickPickItem } from './git/gitStateDetector';
import { areSamePaths, DEFAULT_REVIEW_WORKTREE_PATH, DirtyReviewWorktreeError, fetchPullRequestCommit, fetchPullRequestSnapshot, getPrimaryWorktreeRoot, prepareReviewWorktree, resolveReviewWorktreePath } from './git/reviewWorktree';
import { reviewedFilesStateKey } from './views/reviewState';
import { chooseCheckoutMode } from './views/checkoutMode';
import { DraftPersistenceManager } from './views/draftPersistence';

const OUTPUT_CHANNEL_NAME = 'Azure DevOps PR';
const REVIEW_WORKTREE_OPEN_KEY = 'reviewWorktreeOpenPath';
const DRAFT_STATE_KEY = 'draftComments';
let flushDraftSaves: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext) {
	flushDraftSaves = undefined;
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

	// Tenant cache — maps AzDO org name → Entra tenant ID (persisted across sessions)
	const TENANT_CACHE_KEY = 'azdo-tenant-cache';
	const tenantCache = {
		get(org: string): string | undefined {
			const map = context.globalState.get<Record<string, string>>(TENANT_CACHE_KEY);
			return map?.[org];
		},
		set(org: string, tenantId: string): void {
			const map = context.globalState.get<Record<string, string>>(TENANT_CACHE_KEY) ?? {};
			map[org] = tenantId;
			void context.globalState.update(TENANT_CACHE_KEY, map);
		},
	};

	let apiClient: AzDoApiClient | undefined;
	let prService: PullRequestService | undefined;
	let currentUserId: string | undefined;
	let treeProvider: PrTreeDataProvider | undefined;
	let treeProviderSub: vscode.Disposable | undefined;
	let activePrProvider: ActivePrTreeDataProvider | undefined;
	let activePrProviderSub: vscode.Disposable | undefined;
	let activePrCommentSub: vscode.Disposable | undefined;
	let activePrTreeView: vscode.TreeView<ActivePrTreeItem> | undefined;
	let lastAutoRecoveryTime = 0;
	let pinnedSnapshotReview: { pr: GitPullRequest; sourceRef: string; targetRef: string; repoRoot: string } | undefined;

	// Inline comment controller — lives for the extension's lifetime
	const commentController = new PrCommentController(outputChannel, gitApi, detector);
	context.subscriptions.push(commentController);
	const draftPersistence = new DraftPersistenceManager(
		context.workspaceState,
		DRAFT_STATE_KEY,
		prId => commentController.serializeDraftsForPr(prId),
		outputChannel,
	);
	context.subscriptions.push(draftPersistence);
	flushDraftSaves = () => draftPersistence.flush();

	// --- AI Chat Participant & Context Provider ---
	const prContextProvider = new PrContextProvider();
	registerPrChatParticipant(context, prContextProvider, commentController, outputChannel, gitApi, detector);
	registerPrTools(context, prContextProvider, outputChannel, gitApi, detector);

	// --- Review Mode ---
	const requestedReviewWorktreePath = context.globalState.get<string>(REVIEW_WORKTREE_OPEN_KEY);
	const currentRepositoryPath = getActiveRepository(gitApi, detector)?.rootUri.fsPath;
	const openedForWorktreeReview = !!requestedReviewWorktreePath
		&& !!currentRepositoryPath
		&& areSamePaths(requestedReviewWorktreePath, currentRepositoryPath);
	let reviewMode = context.workspaceState.get<boolean>('reviewMode', openedForWorktreeReview);
	if (openedForWorktreeReview) {
		await context.globalState.update(REVIEW_WORKTREE_OPEN_KEY, undefined);
		await context.workspaceState.update('reviewMode', true);
		outputChannel.appendLine(`[worktree] Opened review workspace: ${currentRepositoryPath}`);
	}

	// --- Draft Persistence ---
	const draftsRestoredForPr = new Set<number>();

	// Track branches checked out by the extension (for auto-delete on switch)
	function getExtensionCheckedOutBranches(): Set<string> {
		const arr = context.workspaceState.get<string[]>('extensionCheckedOutBranches', []);
		return new Set(arr);
	}
	function trackCheckedOutBranch(branchName: string): void {
		const branches = getExtensionCheckedOutBranches();
		branches.add(branchName);
		void context.workspaceState.update('extensionCheckedOutBranches', [...branches]);
	}
	function untrackCheckedOutBranch(branchName: string): void {
		const branches = getExtensionCheckedOutBranches();
		branches.delete(branchName);
		void context.workspaceState.update('extensionCheckedOutBranches', [...branches]);
	}
	async function autoDeletePreviousBranch(repoRoot: string, previousBranch: string | undefined): Promise<void> {
		if (!previousBranch) { return; }
		const autoDelete = vscode.workspace.getConfiguration('vscode-pr-azdo').get<boolean>('autoDeleteBranchOnSwitch', false);
		if (!autoDelete) { return; }
		if (!getExtensionCheckedOutBranches().has(previousBranch)) {
			outputChannel.appendLine(`[auto-delete] Skipping "${previousBranch}" — not checked out by extension`);
			return;
		}
		outputChannel.appendLine(`[auto-delete] Deleting previous branch: ${previousBranch}`);
		try {
			const inSync = await isBranchInSyncWithRemote(repoRoot, previousBranch);
			if (!inSync) {
				outputChannel.appendLine(`[auto-delete] Skipping "${previousBranch}" — local branch has unpushed commits or no upstream`);
				return;
			}
			await deleteLocalBranch(repoRoot, previousBranch);
			untrackCheckedOutBranch(previousBranch);
			outputChannel.appendLine(`[auto-delete] Deleted "${previousBranch}"`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			outputChannel.appendLine(`[auto-delete] Failed to delete "${previousBranch}": ${msg}`);
		}
	}

	/**
	 * After checking out a branch, bring it up to date with its upstream.
	 *  - Up to date or ahead-only: no-op.
	 *  - Behind, not diverged: fast-forward silently.
	 *  - Diverged (behind > 0 AND ahead > 0): prompt the user. Default is to
	 *    leave the branch as-is so we never silently destroy local commits.
	 */
	async function syncBranchWithUpstream(repoRoot: string, branchName: string): Promise<void> {
		const counts = await getBranchAheadBehind(repoRoot, branchName);
		if (!counts) {
			outputChannel.appendLine(`[sync] "${branchName}" has no upstream — skipping fast-forward`);
			return;
		}
		outputChannel.appendLine(`[sync] "${branchName}" is ahead ${counts.ahead}, behind ${counts.behind}`);
		if (counts.behind === 0) {
			return;
		}
		if (counts.ahead === 0) {
			try {
				await fastForwardToUpstream(repoRoot, branchName);
				outputChannel.appendLine(`[sync] Fast-forwarded "${branchName}" by ${counts.behind} commit(s)`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				outputChannel.appendLine(`[sync] Fast-forward failed: ${msg}`);
				vscode.window.showWarningMessage(`Could not fast-forward "${branchName}" to remote: ${msg}`);
			}
			return;
		}
		// Diverged — local has commits the remote doesn't, and vice versa.
		const choice = await vscode.window.showWarningMessage(
			`Local "${branchName}" has diverged from origin (ahead ${counts.ahead}, behind ${counts.behind}). The PR branch was likely force-pushed.`,
			{ modal: false },
			'Reset to remote (discards local commits)',
			'Keep local',
		);
		if (choice === 'Reset to remote (discards local commits)') {
			try {
				await resetBranchToUpstream(repoRoot, branchName);
				outputChannel.appendLine(`[sync] Hard-reset "${branchName}" to upstream`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				outputChannel.appendLine(`[sync] Reset failed: ${msg}`);
				vscode.window.showErrorMessage(`Failed to reset "${branchName}" to remote: ${msg}`);
			}
		} else {
			outputChannel.appendLine(`[sync] User chose to keep local "${branchName}"`);
		}
	}

	const reviewModeStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	reviewModeStatusBar.command = 'vscode-pr-azdo.toggleReviewMode';
	context.subscriptions.push(reviewModeStatusBar);

	function updateReviewModeUi(hasActivePr: boolean): void {
		void vscode.commands.executeCommand('setContext', 'vscode-pr-azdo:reviewMode', reviewMode);
		if (reviewMode) {
			reviewModeStatusBar.text = '$(eye) Reviewing';
			reviewModeStatusBar.tooltip = 'Review Mode ON — click to hide comments';
		} else {
			reviewModeStatusBar.text = '$(eye-closed) Review';
			reviewModeStatusBar.tooltip = 'Review Mode OFF — click to show comments';
		}
		if (hasActivePr) {
			reviewModeStatusBar.show();
		} else {
			reviewModeStatusBar.hide();
		}
	}

	function applyReviewMode(): void {
		commentController.setReviewMode(reviewMode);
		activePrProvider?.setReviewMode(reviewMode);
		updateReviewModeUi(!!activePrProvider?._activePrForContext);
		if (activePrTreeView) {
			activePrTreeView.description = reviewMode ? 'reviewing' : '';
		}
	}

	async function pinPullRequestSnapshot(pr: GitPullRequest): Promise<boolean> {
		if (!pr.pullRequestId || !pr.sourceRefName || !pr.targetRefName) {
			vscode.window.showWarningMessage('Pull request source or target information is unavailable.');
			return false;
		}
		const repo = getActiveRepository(gitApi, detector);
		const remoteInfo = detector.currentRemoteInfo;
		if (!repo || !remoteInfo) {
			vscode.window.showWarningMessage('No Azure DevOps git repository found.');
			return false;
		}

		try {
			const snapshot = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Preparing no-checkout review for PR #${pr.pullRequestId}…` },
				() => fetchPullRequestSnapshot(
					repo.rootUri.fsPath,
					remoteInfo.remoteName,
					pr.pullRequestId!,
					pr.sourceRefName!,
					pr.targetRefName!,
				),
			);
			pinnedSnapshotReview = {
				pr,
				sourceRef: snapshot.sourceCommit,
				targetRef: snapshot.targetCommit,
				repoRoot: repo.rootUri.fsPath,
			};
			gitContentProvider.clearCache();
			activePrProvider?.pinSnapshotReview(pr, snapshot.sourceCommit, snapshot.targetCommit);
			if (!reviewMode) {
				reviewMode = true;
				await context.workspaceState.update('reviewMode', true);
				applyReviewMode();
			}
			outputChannel.appendLine(`[snapshot] Pinned PR #${pr.pullRequestId}: ${snapshot.targetCommit.substring(0, 12)}..${snapshot.sourceCommit.substring(0, 12)}`);
			return true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			outputChannel.appendLine(`[snapshot] Failed to prepare PR #${pr.pullRequestId}: ${msg}`);
			vscode.window.showErrorMessage(`Failed to prepare no-checkout review: ${msg}`);
			return false;
		}
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.toggleReviewMode', () => {
			reviewMode = !reviewMode;
			void context.workspaceState.update('reviewMode', reviewMode);
			outputChannel.appendLine(`[ext] Review mode toggled: ${reviewMode}`);
			applyReviewMode();
		}),
	);

	// Git ref content provider for diff views
	const gitContentProvider = new GitRefContentProvider(outputChannel, gitApi, detector);
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(GIT_CONTENT_SCHEME, gitContentProvider),
	);

	// Virtual document provider for PR-level comments
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(PR_COMMENTS_SCHEME, {
			provideTextDocumentContent(): string {
				return '// PR-level comment threads are displayed as inline comments on this document.\n// You can reply, resolve, or use Copilot on them just like file-level comments.\n';
			},
		}),
	);

	// Open the PR-level comments document
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.openPrComments', async () => {
			const uri = vscode.Uri.parse(`${PR_COMMENTS_SCHEME}:///PR-Comments`);
			const doc = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(doc, { preview: false });
		}),
	);

	// Stable emitters that the tree views subscribe to once.
	const proxyEmitter = new vscode.EventEmitter<void>();
	context.subscriptions.push(proxyEmitter);
	const activePrProxyEmitter = new vscode.EventEmitter<void>();
	context.subscriptions.push(activePrProxyEmitter);

	// Suppress tree auto-expand during background operations (startup, silent auth)
	// to prevent the extension panel from stealing focus.
	let suppressAutoExpand = true;

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
			apiClient = new AzDoApiClient(authProvider, info, outputChannel, tenantCache);
			context.subscriptions.push(apiClient);

			// Try silent authentication — never prompts the user.
			// If a cached token exists it will be reused; otherwise tree views
			// will show a "Sign In" item and the user can authenticate on demand.
			const userIdPromise = apiClient.tryConnectSilently().then(connected => {
				void vscode.commands.executeCommand(
					'setContext', 'vscode-pr-azdo:isAuthenticated', connected,
				);
				if (!connected) {
					outputChannel.appendLine('[ext] Silent auth unavailable — sign-in deferred until user action.');
					// Fire so tree views render the "Sign In" item
					proxyEmitter.fire();
					activePrProxyEmitter.fire();
					return undefined;
				}
				// Silent auth succeeded — kick off active PR detection now that
				// we're connected (the initial detection was skipped because
				// tryConnectSilently hadn't completed yet).
				outputChannel.appendLine('[ext] Silent auth succeeded — triggering active PR detection.');
				activePrProvider?.refresh();
				proxyEmitter.fire();
				return apiClient!.getCurrentUserId().catch(err => {
					if (err instanceof TenantMismatchError) {
						outputChannel.appendLine(`[ext] Tenant mismatch: ${err.message}`);
						void vscode.window.showErrorMessage(
							`Authentication failed for Azure DevOps organization "${err.organization}". ` +
							(err.discoveredTenantId
								? `The organization requires tenant ${err.discoveredTenantId}, but your current session doesn't have access. `
								: 'Your current session may be for the wrong Entra tenant. ') +
							'This is common with multi-tenant Microsoft accounts.',
							'Switch Account',
						).then(action => {
							if (action === 'Switch Account') {
								void vscode.commands.executeCommand('vscode-pr-azdo.switchAccount');
							}
						});
					}
					return undefined;
				});
			}).catch(err => {
				const msg = err instanceof Error ? err.message : String(err);
				outputChannel.appendLine(`[ext] Silent auth failed unexpectedly: ${msg}`);
				void vscode.commands.executeCommand(
					'setContext', 'vscode-pr-azdo:isAuthenticated', false,
				);
				proxyEmitter.fire();
				activePrProxyEmitter.fire();
				return undefined;
			});

			prService = new PullRequestService(apiClient, info);
			const handleAuthError = () => {
				const now = Date.now();
				if (now - lastAutoRecoveryTime < 30_000) {
					outputChannel.appendLine('[ext] Auth error detected but skipping auto-recovery (cooldown).');
					return;
				}
				lastAutoRecoveryTime = now;
				outputChannel.appendLine('[ext] Auth error detected — attempting silent re-auth…');
				// Keep tenant cache — the org's tenant hasn't changed, only the token expired.
				apiClient?.resetConnection();

				// Try to reconnect silently (VS Code may have refreshed the token).
				// If that fails, just update the UI so "Sign In" items appear.
				void apiClient?.tryConnectSilently().then(connected => {
					void vscode.commands.executeCommand(
						'setContext', 'vscode-pr-azdo:isAuthenticated', connected,
					);
					if (connected) {
						outputChannel.appendLine('[ext] Silent re-auth succeeded.');
						// Re-fire so tree views refresh with real data
						proxyEmitter.fire();
						activePrProxyEmitter.fire();
					} else {
						outputChannel.appendLine('[ext] Silent re-auth failed — showing sign-in prompt in tree views.');
						proxyEmitter.fire();
						activePrProxyEmitter.fire();
						vscode.window.showInformationMessage(
							'Azure DevOps PR: Session expired. Click "Sign In" in the panel to re-authenticate.',
						);
					}
				}).catch(err => {
					const msg = err instanceof Error ? err.message : String(err);
					outputChannel.appendLine(`[ext] Silent re-auth failed unexpectedly: ${msg}`);
					void vscode.commands.executeCommand(
						'setContext', 'vscode-pr-azdo:isAuthenticated', false,
					);
					proxyEmitter.fire();
					activePrProxyEmitter.fire();
				});
			};
			treeProvider = new PrTreeDataProvider(prService, apiClient, outputChannel, handleAuthError);
			context.subscriptions.push(treeProvider);

			activePrProvider = new ActivePrTreeDataProvider(prService, gitApi!, outputChannel, handleAuthError);
			activePrProvider.setDraftProvider(() => commentController.getDraftSummaries());
			context.subscriptions.push(activePrProvider);

			// Forward real provider's change events through stable proxy emitters
			let lastExpandedPrId: number | undefined;
			treeProviderSub = treeProvider.onDidChangeTreeData(() => {
				proxyEmitter.fire();
			});
			activePrProviderSub = activePrProvider.onDidChangeTreeData(() => {
				const hasActivePr = !!activePrProvider?._activePrForContext;
				void vscode.commands.executeCommand(
					'setContext', 'vscode-pr-azdo:hasActivePr', hasActivePr,
				);
				void vscode.commands.executeCommand(
					'setContext', 'vscode-pr-azdo:snapshotReview', !!activePrProvider?.isSnapshotReview,
				);
				updateReviewModeUi(hasActivePr);

				// Restore persisted reviewed-files state for the newly active PR
				const prId = activePrProvider?._activePrForContext?.pullRequestId;
				if (prId && activePrProvider!.reviewedFiles.size === 0) {
					const persisted = context.workspaceState.get<string[]>(reviewedFilesStateKey(prId));
					if (persisted && persisted.length > 0) {
						activePrProvider!.setReviewedFiles(persisted);
						outputChannel.appendLine(`[reviewed] Restored ${persisted.length} reviewed file(s) for PR #${prId}`);
					}
				}

				activePrProxyEmitter.fire();

				// Auto-expand the tree when a new PR becomes active (only if authenticated
				// and not during a background operation that would steal focus)
				if (prId && prId !== lastExpandedPrId && apiClient?.isConnected && !suppressAutoExpand) {
					lastExpandedPrId = prId;
					// Delay slightly to let the tree render before expanding
					setTimeout(() => {
						void vscode.commands.executeCommand('vscode-pr-azdo.expandAll');
					}, 500);
				}
			});
			// Update inline comments only after threads are actually loaded.
			// Wait for userId to resolve first so own-comment delete buttons appear immediately.
			activePrCommentSub = activePrProvider.onDidUpdateComments(() => {
				void userIdPromise.then(async uid => {
					currentUserId = uid;
					const pr = activePrProvider?._activePrForContext;
					const reviewContext = activePrProvider?.reviewContext;
					const targetBranch = pr?.targetRefName?.replace(/^refs\/heads\//, '');
					const targetRef = reviewContext?.targetRef ?? (targetBranch ? `origin/${targetBranch}` : undefined);
					commentController.setPrContext(
						prService,
						pr?.pullRequestId,
						activePrProvider?.changedFilePaths,
						currentUserId,
						activePrProvider?.changeTypes,
						targetRef,
						reviewContext?.mode === 'snapshot' ? reviewContext.sourceRef : undefined,
					);
					await commentController.updateThreads(activePrProvider?.filteredThreads);
					if (pr?.pullRequestId !== activePrProvider?._activePrForContext?.pullRequestId) {
						return;
					}
					// Keep AI context provider in sync
					prContextProvider.setActivePr(pr, activePrProvider?.changedFilePaths, activePrProvider?.iterations, reviewContext);

					// Restore persisted drafts once after threads are loaded
					if (pr?.pullRequestId
						&& vscode.workspace.getConfiguration('vscode-pr-azdo').get<boolean>('persistDraftComments')
						&& !draftsRestoredForPr.has(pr.pullRequestId)) {
						draftsRestoredForPr.add(pr.pullRequestId);
						const saved = context.workspaceState.get<PersistedDrafts>(`${DRAFT_STATE_KEY}-${pr.pullRequestId}`);
						if (saved) {
							commentController.restoreDrafts(saved);
						}
					}
				});
			});

		} else {
			outputChannel.appendLine('[ext] No remote info — tree providers not created');
		}

		// Tell both tree views to re-query
		proxyEmitter.fire();
		activePrProxyEmitter.fire();
		void vscode.commands.executeCommand('setContext', 'vscode-pr-azdo:hasActivePr', false);
		commentController.setPrContext(undefined, undefined);
		commentController.updateThreads(undefined); // Clear inline comments
		prContextProvider.setActivePr(undefined);
		applyReviewMode();

		const activeRepoRoot = getActiveRepository(gitApi, detector)?.rootUri.fsPath;
		if (activePrProvider && pinnedSnapshotReview && activeRepoRoot && areSamePaths(pinnedSnapshotReview.repoRoot, activeRepoRoot)) {
			activePrProvider.pinSnapshotReview(
				pinnedSnapshotReview.pr,
				pinnedSnapshotReview.sourceRef,
				pinnedSnapshotReview.targetRef,
			);
		}
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

	// Smart click handler: single click opens webview, double click checks out
	let lastClickedPrId: number | undefined;
	let lastClickTime = 0;
	let singleClickTimer: ReturnType<typeof setTimeout> | undefined;
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.prItemClick', (pr: GitPullRequest) => {
			const prId = pr.pullRequestId;
			const now = Date.now();

			if (prId === lastClickedPrId && (now - lastClickTime) < 400) {
				// Double click — cancel pending single-click and checkout
				if (singleClickTimer) { clearTimeout(singleClickTimer); singleClickTimer = undefined; }
				outputChannel.appendLine(`[ext] Double-click on PR #${prId} — checking out`);
				void vscode.commands.executeCommand('vscode-pr-azdo.checkoutPullRequest', { pr });
				lastClickedPrId = undefined;
				lastClickTime = 0;
			} else {
				// First click — schedule single-click action
				lastClickedPrId = prId;
				lastClickTime = now;
				if (singleClickTimer) { clearTimeout(singleClickTimer); }
				singleClickTimer = setTimeout(() => {
					singleClickTimer = undefined;
					void vscode.commands.executeCommand('vscode-pr-azdo.openPullRequest', pr);
				}, 400);
			}
		}),
	);

	// Refresh command
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.refreshPullRequests', async () => {
			const repo = getActiveRepository(gitApi, detector);
			if (repo) {
				try {
					await vscode.window.withProgress(
						{ location: vscode.ProgressLocation.Window, title: 'Fetching from origin…' },
						async () => { await repo.fetch(); },
					);
					outputChannel.appendLine('[refresh] git fetch completed');
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					outputChannel.appendLine(`[refresh] git fetch failed (continuing with API refresh): ${msg}`);
				}
			}
			treeProvider?.refresh();
		}),
	);

	// --- Active PR tree view ---
	activePrTreeView = vscode.window.createTreeView<ActivePrTreeItem>('azdo-pr.activePr', {
		treeDataProvider: {
			onDidChangeTreeData: activePrProxyEmitter.event,
			getTreeItem(element: ActivePrTreeItem) {
				return activePrProvider?.getTreeItem(element) ?? new vscode.TreeItem('');
			},
			getChildren(element?: ActivePrTreeItem) {
				return activePrProvider?.getChildren(element) ?? Promise.resolve([]);
			},
			getParent(element: ActivePrTreeItem) {
				return activePrProvider?.getParent(element);
			},
		},
		showCollapseAll: true,
		manageCheckboxStateManually: true,
	});
	context.subscriptions.push(activePrTreeView);

	// Handle file review checkboxes
	context.subscriptions.push(
		activePrTreeView.onDidChangeCheckboxState(e => {
			if (!activePrProvider) { return; }

			for (const [item, newState] of e.items) {
				const checked = newState === vscode.TreeItemCheckboxState.Checked;

				if (item instanceof FileChangeItem) {
					activePrProvider.markFileReviewed(item.filePath, checked);
				} else if (item instanceof FolderItem) {
					// Recursively mark all descendant files
					const descendantPaths = activePrProvider.collectDescendantFilePaths(item);
					for (const fp of descendantPaths) {
						activePrProvider.markFileReviewed(fp, checked);
					}
				}
			}

			// Recompute all checkbox states (folders depend on children) and refresh
			activePrProvider.applyCheckboxStates();
			activePrProxyEmitter.fire();

			// Persist to workspace state
			const prId = activePrProvider._activePrForContext?.pullRequestId;
			if (prId) {
				const reviewed = [...activePrProvider.reviewedFiles];
				void context.workspaceState.update(reviewedFilesStateKey(prId), reviewed);
				outputChannel.appendLine(`[reviewed] Persisted ${reviewed.length} reviewed file(s) for PR #${prId}`);
			}
		}),
	);

	// Refresh active PR command
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.refreshActivePr', async () => {
			suppressAutoExpand = false;
			if (pinnedSnapshotReview) {
				await pinPullRequestSnapshot(pinnedSnapshotReview.pr);
				return;
			}
			const repo = getActiveRepository(gitApi, detector);
			if (repo) {
				try {
					await vscode.window.withProgress(
						{ location: vscode.ProgressLocation.Window, title: 'Fetching from origin…' },
						async () => { await repo.fetch(); },
					);
					outputChannel.appendLine('[refresh] git fetch completed');
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					outputChannel.appendLine(`[refresh] git fetch failed (continuing with API refresh): ${msg}`);
				}
			}
			activePrProvider?.refresh();
			gitContentProvider.clearCache();
		}),
	);

	// --- Active-editor-in-PR context key ---
	function updateActiveEditorInPrContext(): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor || !activePrProvider?._activePrForContext) {
			void vscode.commands.executeCommand('setContext', 'vscode-pr-azdo:activeEditorInPr', false);
			return;
		}
		const repoRoot = getActiveRepository(gitApi, detector)?.rootUri;
		const inPr = activePrProvider.isSnapshotReview
			? editor.document.uri.scheme === GIT_CONTENT_SCHEME
				&& isUriInChangedFiles(editor.document.uri, repoRoot, activePrProvider.changedFilePaths)
			: isUriInChangedFiles(editor.document.uri, repoRoot, activePrProvider.changedFilePaths);
		void vscode.commands.executeCommand('setContext', 'vscode-pr-azdo:activeEditorInPr', inPr);
	}

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => updateActiveEditorInPrContext()),
	);
	// Also re-evaluate when PR data changes
	context.subscriptions.push(
		activePrProxyEmitter.event(() => updateActiveEditorInPrContext()),
	);

	// --- Toggle between file view and diff view ---
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.toggleFileDiff', async () => {
			const pr = activePrProvider?._activePrForContext;
			if (!pr) {
				outputChannel.appendLine('[toggle] Cannot toggle: no active pull request.');
				return;
			}

			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				outputChannel.appendLine('[toggle] Cannot toggle: no active editor.');
				return;
			}

			const uri = editor.document.uri;
			const cursorLine = editor.selection.active.line;
			const targetBranch = pr.targetRefName?.replace(/^refs\/heads\//, '') ?? 'main';
			const sourceBranch = pr.sourceRefName?.replace(/^refs\/heads\//, '');
			const reviewContext = activePrProvider?.reviewContext;
			const targetRef = reviewContext?.targetRef ?? `origin/${targetBranch}`;
			const sourceRef = reviewContext?.mode === 'snapshot' ? reviewContext.sourceRef : undefined;
			const repoRoot = getActiveRepository(gitApi, detector)?.rootUri;
			if (!repoRoot) {
				outputChannel.appendLine('[toggle] Cannot toggle: repository root not found.');
				return;
			}

			const activeTabInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
			const diffFileUri = getWorkspaceFileUriFromDiffInput(activeTabInput);
			const isDiffTab = activeTabInput instanceof vscode.TabInputTextDiff;

			if (isDiffTab) {
				if (sourceRef) {
					const input = activeTabInput as vscode.TabInputTextDiff;
					const sourcePath = extractPathFromGitRefUri(input.modified);
					const targetPath = extractPathFromGitRefUri(input.original);
					const relative = sourcePath ?? targetPath;
					if (!relative) { return; }
					const singleUri = sourcePath
						? buildGitRefUri(relative, sourceRef)
						: buildGitRefUri(relative, targetRef);
					const doc = await vscode.workspace.openTextDocument(singleUri);
					const e = await vscode.window.showTextDocument(doc, { preview: false });
					const pos = new vscode.Position(Math.min(cursorLine, Math.max(0, e.document.lineCount - 1)), 0);
					e.selection = new vscode.Selection(pos, pos);
					e.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
					return;
				}
				// Diff → File: activeTextEditor may be the file-backed modified side,
				// so the URI scheme alone cannot identify the current editor as a diff.
				if (!diffFileUri) {
					outputChannel.appendLine('[toggle] Cannot open workspace file: diff has no file-backed side.');
					vscode.window.showInformationMessage('This file was deleted in the pull request — there is no working-copy version to open.');
					return;
				}

				const relative = computeRelativePath(diffFileUri, repoRoot);
				if (!relative) {
					outputChannel.appendLine(`[toggle] Cannot resolve diff file under repository root: ${diffFileUri.path}`);
					return;
				}

				outputChannel.appendLine(`[toggle] Diff → File for ${relative}`);
				await vscode.commands.executeCommand(
					'vscode.openWith',
					diffFileUri,
					'default',
					{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
				);
				const e = vscode.window.activeTextEditor;
				if (!e || e.document.uri.toString() !== diffFileUri.toString()) {
					outputChannel.appendLine(`[toggle] Workspace file did not become active for ${relative}.`);
					return;
				}
				const pos = new vscode.Position(Math.min(cursorLine, Math.max(0, e.document.lineCount - 1)), 0);
				e.selection = new vscode.Selection(pos, pos);
				e.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
				outputChannel.appendLine(`[toggle] Opened workspace file for ${relative}.`);
			} else if (uri.scheme === 'file') {
				// File → Diff: compute relative path, look up change type, open diff
				const relative = computeRelativePath(uri, repoRoot);
				if (!relative) {
					outputChannel.appendLine(`[toggle] Cannot resolve active file under repository root: ${uri.path}`);
					return;
				}

				const changeType = activePrProvider?.getChangeType(relative) ?? VersionControlChangeType.Edit;
				const diff = buildDiffParams(relative, changeType, repoRoot, targetRef, targetBranch, sourceRef, sourceBranch);

				outputChannel.appendLine(`[toggle] File → Diff for ${relative}`);
				await vscode.commands.executeCommand('vscode.diff', diff.leftUri, diff.rightUri, diff.title);
				outputChannel.appendLine(`[toggle] Opened diff for ${relative}.`);

				// Scroll to same line
				setTimeout(() => {
					const e = vscode.window.activeTextEditor;
					if (e) {
						const pos = new vscode.Position(cursorLine, 0);
						e.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
					}
				}, 300);
			} else if (uri.scheme === GIT_CONTENT_SCHEME) {
				if (sourceRef) {
					const path = extractPathFromGitRefUri(uri);
					if (!path) { return; }
					const changeType = activePrProvider?.getChangeType(path) ?? VersionControlChangeType.Edit;
					const diff = buildDiffParams(path, changeType, repoRoot, targetRef, targetBranch, sourceRef, sourceBranch);
					await vscode.commands.executeCommand('vscode.diff', diff.leftUri, diff.rightUri, diff.title);
					return;
				}
				// Diff → File: extract file path, open workspace file
				const path = extractPathFromGitRefUri(uri);
				if (!path) {
					outputChannel.appendLine('[toggle] Cannot resolve file path from git-content URI.');
					return;
				}

				// For deleted files there is no working-copy file to toggle to
				const ctForToggle = activePrProvider?.getChangeType(path);
				if (ctForToggle !== undefined && (ctForToggle & VersionControlChangeType.Delete)) {
					outputChannel.appendLine(`[toggle] Cannot open deleted workspace file: ${path}`);
					vscode.window.showInformationMessage('This file was deleted in the pull request — there is no working-copy version to open.');
					return;
				}

				outputChannel.appendLine(`[toggle] Diff → File for ${path}`);
				const fileUri = vscode.Uri.joinPath(repoRoot, path);
				const doc = await vscode.workspace.openTextDocument(fileUri);
				const e = await vscode.window.showTextDocument(doc);
				const pos = new vscode.Position(cursorLine, 0);
				e.selection = new vscode.Selection(pos, pos);
				e.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
				outputChannel.appendLine(`[toggle] Opened workspace file for ${path}.`);
			} else {
				outputChannel.appendLine(`[toggle] Cannot toggle unsupported URI scheme: ${uri.scheme}`);
			}
		}),
	);

	// Expand all items in the active PR tree
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.expandAll', async () => {
			if (!activePrProvider || !activePrTreeView) { return; }

			async function expandRecursive(items: ActivePrTreeItem[]): Promise<void> {
				for (const item of items) {
					const isExpandable = item instanceof ActivePrRootItem
						|| item instanceof SectionHeaderItem
						|| item instanceof FolderItem;
					if (isExpandable) {
						await activePrTreeView!.reveal(item, { expand: true, select: false, focus: false });
						const children = await activePrProvider!.getChildren(item);
						await expandRecursive(children);
					}
				}
			}

			const roots = await activePrProvider.getChildren();
			await expandRecursive(roots);
		}),
	);

	// Navigate to a comment in the file
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.goToComment', async (filePath: string, line: number) => {
			const repoRoot = getActiveRepository(gitApi, detector)?.rootUri;
			if (!repoRoot) { return; }

			const pos = new vscode.Position(Math.max(0, line - 1), 0);

			// Deleted files have no working copy — open the old content from the
			// target branch as a single read-only editor (a diff view stacks
			// inline by default which hides the comment gutter on the left side).
			const changeType = activePrProvider?.getChangeType(filePath);
			const reviewContext = activePrProvider?.reviewContext;
			if (reviewContext?.mode === 'snapshot') {
				const ref = changeType !== undefined && (changeType & VersionControlChangeType.Delete)
					? reviewContext.targetRef
					: reviewContext.sourceRef;
				if (!ref) { return; }
				const uri = buildGitRefUri(filePath, ref);
				const doc = await vscode.workspace.openTextDocument(uri);
				const editor = await vscode.window.showTextDocument(doc, { preview: false });
				editor.selection = new vscode.Selection(pos, pos);
				editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
				return;
			}
			if (changeType !== undefined && (changeType & VersionControlChangeType.Delete)) {
				const pr = activePrProvider?._activePrForContext;
				const targetBranch = pr?.targetRefName?.replace(/^refs\/heads\//, '') ?? 'main';
				const targetRef = `origin/${targetBranch}`;
				const uri = buildGitRefUri(filePath, targetRef);
				outputChannel.appendLine(`[goToComment] Deleted file ${filePath} — opening ${uri.toString()} at L${line}`);
				const doc = await vscode.workspace.openTextDocument(uri);
				const editor = await vscode.window.showTextDocument(doc, { preview: false });
				editor.selection = new vscode.Selection(pos, pos);
				editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
				return;
			}

			const fileUri = vscode.Uri.joinPath(repoRoot, filePath);
			const doc = await vscode.workspace.openTextDocument(fileUri);
			const editor = await vscode.window.showTextDocument(doc);
			editor.selection = new vscode.Selection(pos, pos);
			editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
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
			];
			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: 'Filter comment threads',
			});
			if (!picked) { return; }
			const filterMap: Record<string, 'active' | 'all'> = {
				'$(comment) Active Comments': 'active',
				'$(comment-discussion) All Comments': 'all',
			};
			const filter = filterMap[picked.label];
			if (filter) {
				activePrProvider.setCommentFilter(filter);
				outputChannel.appendLine(`[ext] Comment filter set to: ${filter}`);
			}
		}),
	);

	// Filter comments by author
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.filterCommentsByAuthor', async () => {
			if (!activePrProvider) { return; }
			const current = activePrProvider.authorFilter;
			const authors = activePrProvider.getUniqueAuthors();
			const items: vscode.QuickPickItem[] = [
				{ label: '$(organization) All Authors', description: 'Show comments from everyone', detail: current === null ? '(current)' : undefined },
				...authors.map(name => ({
					label: `$(person) ${name}`,
					detail: current === name ? '(current)' : undefined,
				})),
			];
			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: 'Filter comment threads by author',
			});
			if (!picked) { return; }
			if (picked.label === '$(organization) All Authors') {
				activePrProvider.setAuthorFilter(null);
				outputChannel.appendLine('[ext] Author filter cleared');
			} else {
				const name = picked.label.replace('$(person) ', '');
				activePrProvider.setAuthorFilter(name);
				outputChannel.appendLine(`[ext] Author filter set to: ${name}`);
			}
		}),
	);

	// --- Comment interaction commands ---

	// Submit a comment reply or new comment
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.submitComment', async (reply: vscode.CommentReply) => {
			outputChannel.appendLine(`[comments] submitComment ENTER: reply=${!!reply}, thread=${!!reply?.thread}, text=${reply?.text?.substring(0, 60) ?? '(none)'}`);
			if (!reply) {
				outputChannel.appendLine(`[comments] submitComment: no reply arg — returning`);
				return;
			}

			// Reply draft on existing thread → post as reply to AzDO thread
			if (commentController.hasReplyDraft(reply.thread)) {
				const draftInfo = commentController.getReplyDraftInfo(reply.thread);
				if (!draftInfo || !prService || !activePrProvider?._activePrForContext?.pullRequestId) {
					vscode.window.showWarningMessage('No active PR context.');
					return;
				}
				const prId = activePrProvider._activePrForContext.pullRequestId;
				// Use the submit box text if provided, otherwise use the draft body
				const body = reply.text.trim() || draftInfo.body;
				if (!body.trim()) {
					vscode.window.showWarningMessage('Reply cannot be empty.');
					return;
				}
				try {
					outputChannel.appendLine(`[ai] Posting reply draft to thread ${draftInfo.azdoThreadId}`);
					const created = await prService.createComment(prId, draftInfo.azdoThreadId, body);
					commentController.removeReplyDraft(reply.thread);
					// Optimistically append the posted reply
					reply.thread.comments = [...reply.thread.comments, {
						body: new vscode.MarkdownString(body),
						mode: vscode.CommentMode.Preview,
						author: { name: created.author?.displayName ?? 'You' },
						timestamp: created.publishedDate ? new Date(created.publishedDate) : new Date(),
					}];
					vscode.window.showInformationMessage('Reply posted to Azure DevOps.');
					activePrProvider.refresh();
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					outputChannel.appendLine(`[ai] Failed to post reply draft: ${msg}`);
					vscode.window.showErrorMessage(`Failed to post reply: ${msg}`);
				}
				return;
			}

			// Draft thread → post to AzDO with the (possibly edited) text
			if (commentController.isDraft(reply.thread)) {
				const info = commentController.getDraftInfo(reply.thread);
				if (!info || !prService || !activePrProvider?._activePrForContext?.pullRequestId) {
					vscode.window.showWarningMessage('No active PR context.');
					return;
				}
				const prId = activePrProvider._activePrForContext.pullRequestId;
				const body = reply.text.trim() || info.body;
				try {
					outputChannel.appendLine(`[ai] Posting edited draft on ${info.filePath} L${info.line}`);
					await prService.createThread(prId, body, {
						filePath: `/${info.filePath}`,
						startLine: info.line,
						startCol: 1,
						endLine: info.line,
						endCol: 1,
					});
					commentController.disposeDraft(reply.thread);
					vscode.window.showInformationMessage('Comment posted to Azure DevOps.');
					activePrProvider.refresh();
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					outputChannel.appendLine(`[ai] Failed to post draft: ${msg}`);
					vscode.window.showErrorMessage(`Failed to post comment: ${msg}`);
				}
				return;
			}

			const threadId = commentController.getThreadId(reply.thread);
			if (threadId) {
				// Existing thread → reply
				outputChannel.appendLine(`[comments] submitComment: existing thread ${threadId} → reply`);
				await commentController.handleReply(reply);
			} else if (commentController.isUserDraft(reply.thread)) {
				// User draft thread → post to AzDO with the (possibly edited) text
				outputChannel.appendLine(`[comments] submitComment: user draft thread → post to AzDO`);
				const info = commentController.getUserDraftInfo(reply.thread);
				if (!info || !prService || !activePrProvider?._activePrForContext?.pullRequestId) {
					vscode.window.showWarningMessage('No active PR context.');
					return;
				}
				const prId = activePrProvider._activePrForContext.pullRequestId;
				const body = reply.text.trim() || info.body;
				if (!body.trim()) {
					vscode.window.showWarningMessage('Comment cannot be empty.');
					return;
				}
				try {
					outputChannel.appendLine(`[comments] Posting user draft on ${info.filePath} L${info.startLine} (side=${info.side})`);
					await prService.createThread(prId, body, {
						filePath: `/${info.filePath}`,
						startLine: info.startLine,
						startCol: info.startCol,
						endLine: info.endLine,
						endCol: info.endCol,
						side: info.side,
					});
					commentController.disposeUserDraft(reply.thread);
					vscode.window.showInformationMessage('Comment posted to Azure DevOps.');
					activePrProvider.refresh();
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					outputChannel.appendLine(`[comments] Failed to post user draft: ${msg}`);
					vscode.window.showErrorMessage(`Failed to post comment: ${msg}`);
				}
			} else {
				// New thread from gutter → post immediately
				outputChannel.appendLine(`[comments] submitComment: new gutter thread → posting immediately`);
				await commentController.handleNewComment(reply);
			}
		}),
	);

	// Delete a comment (only the current user's own comments)
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.deleteComment', async (commentArg: unknown) => {
			// VS Code passes the comment object directly from comments/comment/title
			const comment = commentArg as vscode.Comment | undefined;
			if (!comment) {
				vscode.window.showWarningMessage('Cannot identify comment to delete.');
				return;
			}

			// Find the parent thread that contains this comment
			const thread = commentController.findThreadForComment(comment);
			if (!thread) {
				vscode.window.showWarningMessage('Cannot find thread for this comment.');
				return;
			}

			const confirmed = await vscode.window.showWarningMessage(
				'Delete this comment?',
				{ modal: true },
				'Delete',
			);
			if (confirmed !== 'Delete') { return; }

			await commentController.handleDeleteComment(thread, comment);
		}),
	);

	// Thread status commands (work from both inline and sidebar)
	const registerStatusCommand = (commandId: string, status: CommentThreadStatus) => {
		context.subscriptions.push(
			vscode.commands.registerCommand(commandId, async (threadOrItem: vscode.CommentThread | unknown) => {
				outputChannel.appendLine(`[ext] ${commandId} invoked, arg type=${typeof threadOrItem}, keys=${threadOrItem ? Object.keys(threadOrItem as any).join(',') : 'null'}`);

				// Resolve the vscode.CommentThread from the argument.
				// VS Code passes different shapes depending on where the command is invoked:
				//   - Inline thread context menu: a CommentReply-like {thread, text}
				//   - Direct CommentThread: the thread itself (has canReply)
				//   - Sidebar CommentThreadItem: {thread: AzDoThread} (thread.id is a number)
				let vsThread: vscode.CommentThread | undefined;
				const arg = threadOrItem as any;
				if (arg && 'canReply' in arg) {
					// Direct CommentThread object
					vsThread = arg as vscode.CommentThread;
				} else if (arg?.thread && 'canReply' in arg.thread) {
					// CommentReply-like wrapper — unwrap the .thread
					vsThread = arg.thread as vscode.CommentThread;
				}

				if (vsThread) {
					outputChannel.appendLine(`[ext] ${commandId}: resolved inline CommentThread, uri=${vsThread.uri.toString()}`);
					await commentController.updateThreadStatus(vsThread, status);
					return;
				}

				// From sidebar CommentThreadItem — get the AzDO thread and update via service
				const sidebarThread = arg?.thread;
				outputChannel.appendLine(`[ext] ${commandId}: sidebar path — thread?.id=${sidebarThread?.id}, prService=${!!prService}, activePrId=${activePrProvider?._activePrForContext?.pullRequestId}`);
				if (sidebarThread?.id && prService && activePrProvider?._activePrForContext?.pullRequestId) {
					const prId = activePrProvider._activePrForContext.pullRequestId;
					try {
						await prService.updateThreadStatus(prId, sidebarThread.id, status);
						outputChannel.appendLine(`[ext] Thread ${sidebarThread.id} status → ${status}`);
						activePrProvider.refresh();
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						outputChannel.appendLine(`[ext] ${commandId}: FAILED — ${msg}`);
						vscode.window.showErrorMessage(`Failed to update thread: ${msg}`);
					}
				} else {
					outputChannel.appendLine(`[ext] ${commandId}: no matching handler — argument did not match inline or sidebar path`);
				}
			}),
		);
	};

	registerStatusCommand('vscode-pr-azdo.resolveThread', CommentThreadStatus.Fixed);
	registerStatusCommand('vscode-pr-azdo.wontFixThread', CommentThreadStatus.WontFix);
	registerStatusCommand('vscode-pr-azdo.closeThread', CommentThreadStatus.Closed);
	registerStatusCommand('vscode-pr-azdo.reactivateThread', CommentThreadStatus.Active);

	// --- AI: Resolve with Copilot button ---
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.resolveWithAI', async (threadOrItem: unknown) => {
			// Resolve the vscode.CommentThread from the argument
			let vsThread: vscode.CommentThread | undefined;
			const arg = threadOrItem as any;
			if (arg && 'canReply' in arg) {
				vsThread = arg as vscode.CommentThread;
			} else if (arg?.thread && 'canReply' in arg.thread) {
				vsThread = arg.thread as vscode.CommentThread;
			}
			if (!vsThread) {
				vscode.window.showWarningMessage('Cannot identify comment thread.');
				return;
			}

			const azdoThread = commentController.getAzdoThread(vsThread);
			if (!azdoThread) {
				vscode.window.showWarningMessage('Cannot find thread data.');
				return;
			}

			const filePath = azdoThread.threadContext?.filePath;
			const startLine = azdoThread.threadContext?.rightFileStart?.line ?? 1;
			const startCol = azdoThread.threadContext?.rightFileStart?.offset ?? 1;
			const endLine = azdoThread.threadContext?.rightFileEnd?.line ?? startLine;
			const endCol = azdoThread.threadContext?.rightFileEnd?.offset ?? startCol;
			const relativePath = filePath?.startsWith('/') ? filePath.substring(1) : (filePath ?? '');

			// Store context for the chat participant to pick up
			prContextProvider.setCommentContext({
				thread: azdoThread,
				filePath: relativePath,
				startLine,
				startCol,
				endLine,
				endCol,
			});

			outputChannel.appendLine(`[ai] Resolve with AI: thread=${azdoThread.id}, file=${relativePath} L${startLine}:${startCol}-L${endLine}:${endCol}`);

			// Open Copilot Chat with @azdo-pr /fix pre-filled
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				query: '@azdo-pr /fix',
			});
		}),
	);

	// --- AI: Post reply from chat ---
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.postAiReply', async (threadId: number, prefillText?: string) => {
			if (!prService || !activePrProvider?._activePrForContext?.pullRequestId) {
				vscode.window.showWarningMessage('No active PR context.');
				return;
			}

			const text = prefillText?.trim();
			if (!text) {
				vscode.window.showWarningMessage('No reply text provided.');
				return;
			}

			// Find the VS Code comment thread for this AzDO thread
			const vsThread = commentController.findThreadByAzdoId(threadId);
			if (!vsThread) {
				outputChannel.appendLine(`[ai] postAiReply: thread ${threadId} not found inline — falling back to input box`);
				const reply = await vscode.window.showInputBox({
					prompt: 'Edit the reply before posting (or press Enter to post as-is)',
					placeHolder: 'Type your reply…',
					value: text,
				});
				if (reply === undefined || !reply.trim()) { return; }
				const prId = activePrProvider._activePrForContext.pullRequestId;
				try {
					await prService.createComment(prId, threadId, reply);
					outputChannel.appendLine(`[ai] Posted reply to thread ${threadId} (input box fallback)`);
					vscode.window.showInformationMessage('Reply posted to Azure DevOps.');
					activePrProvider.refresh();
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					outputChannel.appendLine(`[ai] Failed to post reply: ${msg}`);
					vscode.window.showErrorMessage(`Failed to post reply: ${msg}`);
				}
				return;
			}

			// Prefill reply as an editable comment in the thread
			commentController.prefillReplyDraft(vsThread, text);
			outputChannel.appendLine(`[ai] Prefilled reply draft on thread ${threadId}`);

			// Navigate to the file and line so the user can see the draft
			try {
				const doc = await vscode.workspace.openTextDocument(vsThread.uri);
				const editor = await vscode.window.showTextDocument(doc, { preview: false });
				const line = vsThread.range?.start.line ?? 0;
				const pos = new vscode.Position(line, 0);
				editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
			} catch {
				// Non-critical — the draft is still in the thread
			}
		}),
	);

	// --- AI: Apply suggestion via Copilot Edits ---
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.applySuggestion', async () => {
			if (activePrProvider?.isSnapshotReview) {
				vscode.window.showInformationMessage('Check out the pull request in the current repository or a review worktree before applying suggestions.');
				return;
			}
			outputChannel.appendLine('[ai] Opening Copilot Edits to apply suggestion');
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				query: 'Apply the suggestion',
			});
		}),
	);

	// --- AI: Review PR from sidebar button ---
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.reviewWithAI', async () => {
			if (activePrProvider?.isSnapshotReview) {
				outputChannel.appendLine('[ai] reviewWithAI: reviewing pinned PR snapshot');
				await vscode.commands.executeCommand('workbench.action.chat.open', {
					query: '@azdo-pr /review --mode=vs-target',
				});
				return;
			}
			outputChannel.appendLine('[ai] reviewWithAI: detecting git state…');
			const repo = getActiveRepository(gitApi, detector);
			if (!repo) {
				outputChannel.appendLine('[ai] reviewWithAI: no git repo found');
				await vscode.commands.executeCommand('workbench.action.chat.open', {
					query: '@azdo-pr /review',
				});
				return;
			}

			// Determine target branch from active PR
			const pr = prContextProvider.activePr;
			const targetBranch = pr?.targetRefName?.replace(/^refs\/heads\//, '') ?? 'main';

			const state = await detectGitState(repo, outputChannel);
			const options = getReviewOptions(state, targetBranch, outputChannel);

			if (!options) {
				// Scenario 1: clean + pushed → auto-proceed
				outputChannel.appendLine('[ai] reviewWithAI: clean+pushed → opening review with vs-target');
				await vscode.commands.executeCommand('workbench.action.chat.open', {
					query: '@azdo-pr /review --mode=vs-target',
				});
				return;
			}

			const picked = await vscode.window.showQuickPick<ReviewQuickPickItem>(options, {
				placeHolder: 'What do you want to review?',
				title: 'Review with Copilot',
			});
			if (!picked) {
				outputChannel.appendLine('[ai] reviewWithAI: user cancelled QuickPick');
				return;
			}

			outputChannel.appendLine(`[ai] reviewWithAI: user selected mode=${picked.reviewMode}`);
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				query: `@azdo-pr /review --mode=${picked.reviewMode}`,
			});
		}),
	);

	// --- AI: Reset prompts to defaults ---
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.resetPrompts', async () => {
			const config = vscode.workspace.getConfiguration('vscode-pr-azdo.prompts');
			await config.update('fixComment', undefined, vscode.ConfigurationTarget.Global);
			await config.update('review', undefined, vscode.ConfigurationTarget.Global);
			await config.update('reviewQuick', undefined, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage('AI prompts reset to defaults.');
			outputChannel.appendLine('[ext] AI prompts reset to defaults');
		}),
	);

	// --- AI: View default prompts ---
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.viewDefaultPrompts', async () => {
			const content = [
				'# Azure DevOps PR — Default AI Prompts',
				'',
				'Copy any section below into the corresponding setting to customize it.',
				'Settings: `vscode-pr-azdo.prompts.fixComment`, `.review`, `.reviewQuick`',
				'',
				'---',
				'',
				'## /fix — Resolve PR Comments',
				'',
				'```',
				DEFAULT_SYSTEM_PROMPT,
				'```',
				'',
				'---',
				'',
				'## /review — Detailed Code Review',
				'',
				'```',
				DEFAULT_REVIEW_PROMPT,
				'```',
				'',
				'---',
				'',
				'## /review-quick — Quick Summary',
				'',
				'```',
				DEFAULT_REVIEW_QUICK_PROMPT,
				'```',
			].join('\n');
			const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
			await vscode.window.showTextDocument(doc, { preview: true });
		}),
	);

	// --- AI Review: Draft comment actions ---
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.postDraft', async (threadOrItem: unknown) => {
			let vsThread: vscode.CommentThread | undefined;
			const arg = threadOrItem as any;
			if (arg && 'canReply' in arg) {
				vsThread = arg as vscode.CommentThread;
			} else if (arg?.thread && 'canReply' in arg.thread) {
				vsThread = arg.thread as vscode.CommentThread;
			}
			if (!vsThread || !commentController.isDraft(vsThread)) {
				vscode.window.showWarningMessage('Not a draft comment.');
				return;
			}
			if (!prService || !activePrProvider?._activePrForContext?.pullRequestId) {
				vscode.window.showWarningMessage('No active PR context.');
				return;
			}

			const info = commentController.getDraftInfo(vsThread);
			if (!info) {
				vscode.window.showWarningMessage('Cannot read draft info.');
				return;
			}

			const prId = activePrProvider._activePrForContext.pullRequestId;
			try {
				outputChannel.appendLine(`[ai] Posting draft comment on ${info.filePath} L${info.line}`);
				await prService.createThread(prId, info.body, {
					filePath: `/${info.filePath}`,
					startLine: info.line,
					startCol: 1,
					endLine: info.line,
					endCol: 1,
				});
				commentController.disposeDraft(vsThread);
				vscode.window.showInformationMessage('Comment posted to Azure DevOps.');
				activePrProvider.refresh();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				outputChannel.appendLine(`[ai] Failed to post draft: ${msg}`);
				vscode.window.showErrorMessage(`Failed to post comment: ${msg}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.dismissDraft', (threadOrItem: unknown) => {
			let vsThread: vscode.CommentThread | undefined;
			const arg = threadOrItem as any;
			if (arg && 'canReply' in arg) {
				vsThread = arg as vscode.CommentThread;
			} else if (arg?.thread && 'canReply' in arg.thread) {
				vsThread = arg.thread as vscode.CommentThread;
			}
			if (vsThread && commentController.isDraft(vsThread)) {
				commentController.disposeDraft(vsThread);
			} else if (vsThread && commentController.hasReplyDraft(vsThread)) {
				commentController.removeReplyDraft(vsThread);
			} else if (vsThread && commentController.isUserDraft(vsThread)) {
				commentController.disposeUserDraft(vsThread);
			}
		}),
	);

	// --- User draft comment actions ---

	// Post a user draft comment to AzDO
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.postUserDraft', async (threadOrItem: unknown) => {
			let vsThread: vscode.CommentThread | undefined;
			const arg = threadOrItem as any;
			if (arg && 'canReply' in arg) {
				vsThread = arg as vscode.CommentThread;
			} else if (arg?.thread && 'canReply' in arg.thread) {
				vsThread = arg.thread as vscode.CommentThread;
			}
			if (!vsThread || !commentController.isUserDraft(vsThread)) {
				vscode.window.showWarningMessage('Not a draft comment.');
				return;
			}
			if (!prService || !activePrProvider?._activePrForContext?.pullRequestId) {
				vscode.window.showWarningMessage('No active PR context.');
				return;
			}

			const info = commentController.getUserDraftInfo(vsThread);
			if (!info) {
				vscode.window.showWarningMessage('Cannot read draft info.');
				return;
			}

			const prId = activePrProvider._activePrForContext.pullRequestId;
			try {
				outputChannel.appendLine(`[comments] Posting user draft on ${info.filePath} L${info.startLine} (side=${info.side})`);
				await prService.createThread(prId, info.body, {
					filePath: `/${info.filePath}`,
					startLine: info.startLine,
					startCol: info.startCol,
					endLine: info.endLine,
					endCol: info.endCol,
					side: info.side,
				});
				commentController.disposeUserDraft(vsThread);
				vscode.window.showInformationMessage('Comment posted to Azure DevOps.');
				activePrProvider.refresh();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				outputChannel.appendLine(`[comments] Failed to post user draft: ${msg}`);
				vscode.window.showErrorMessage(`Failed to post comment: ${msg}`);
			}
		}),
	);

	// Post a user draft from the editing area's inline accept button
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.postUserDraftFromEdit', async (commentArg: unknown) => {
			const comment = commentArg as vscode.Comment | undefined;
			if (!comment) { return; }

			const vsThread = commentController.findThreadForComment(comment);
			if (!vsThread || !commentController.isUserDraft(vsThread)) {
				vscode.window.showWarningMessage('Not a draft comment.');
				return;
			}
			if (!prService || !activePrProvider?._activePrForContext?.pullRequestId) {
				vscode.window.showWarningMessage('No active PR context.');
				return;
			}

			const info = commentController.getUserDraftInfo(vsThread);
			if (!info) {
				vscode.window.showWarningMessage('Cannot read draft info.');
				return;
			}

			const prId = activePrProvider._activePrForContext.pullRequestId;
			// Read the (possibly edited) body from the comment argument
			const editedBody = typeof comment.body === 'string'
				? comment.body
				: (comment.body as vscode.MarkdownString)?.value ?? '';
			const body = editedBody.trim() || info.body;
			if (!body.trim()) {
				vscode.window.showWarningMessage('Comment cannot be empty.');
				return;
			}

			try {
				outputChannel.appendLine(`[comments] Posting edited user draft on ${info.filePath} L${info.startLine} (side=${info.side})`);
				await prService.createThread(prId, body, {
					filePath: `/${info.filePath}`,
					startLine: info.startLine,
					startCol: info.startCol,
					endLine: info.endLine,
					endCol: info.endCol,
					side: info.side,
				});
				commentController.disposeUserDraft(vsThread);
				vscode.window.showInformationMessage('Comment posted to Azure DevOps.');
				activePrProvider.refresh();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				outputChannel.appendLine(`[comments] Failed to post user draft: ${msg}`);
				vscode.window.showErrorMessage(`Failed to post comment: ${msg}`);
			}
		}),
	);

	// Dismiss a user draft comment
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.dismissUserDraft', (threadOrItem: unknown) => {
			let vsThread: vscode.CommentThread | undefined;
			const arg = threadOrItem as any;
			if (arg && 'canReply' in arg) {
				vsThread = arg as vscode.CommentThread;
			} else if (arg?.thread && 'canReply' in arg.thread) {
				vsThread = arg.thread as vscode.CommentThread;
			}
			if (vsThread && commentController.isUserDraft(vsThread)) {
				commentController.disposeUserDraft(vsThread);
			}
		}),
	);

	// Update a draft comment's text without posting
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.updateDraft', (commentArg: unknown) => {
			const comment = commentArg as vscode.Comment | undefined;
			if (!comment) { return; }

			const vsThread = commentController.findThreadForComment(comment);
			if (!vsThread) {
				vscode.window.showWarningMessage('Cannot identify comment thread.');
				return;
			}

			const editedBody = typeof comment.body === 'string'
				? comment.body
				: (comment.body as vscode.MarkdownString)?.value ?? '';
			if (!editedBody.trim()) {
				vscode.window.showWarningMessage('Draft cannot be empty.');
				return;
			}

			if (commentController.isUserDraft(vsThread)) {
				commentController.updateUserDraft(vsThread, editedBody);
				outputChannel.appendLine(`[comments] Updated user draft text`);
			} else if (commentController.hasReplyDraft(vsThread)) {
				commentController.updateReplyDraft(vsThread, editedBody);
				outputChannel.appendLine(`[comments] Updated reply draft text`);
			} else if (commentController.isDraft(vsThread)) {
				commentController.updateAiDraft(vsThread, editedBody);
				outputChannel.appendLine(`[comments] Updated AI draft text`);
			}
		}),
	);

	// Save as draft — works for both new threads and replies on existing threads
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.saveAsDraft', async (reply: vscode.CommentReply) => {
			if (!reply) { return; }
			outputChannel.appendLine(`[comments] saveAsDraft ENTER: text=${reply.text?.substring(0, 60) ?? '(none)'}`);

			const text = reply.text.trim();
			if (!text) {
				vscode.window.showWarningMessage('Comment cannot be empty.');
				return;
			}

			const threadId = commentController.getThreadId(reply.thread);
			if (threadId) {
				// Existing AzDO thread → save reply as draft on this thread
				outputChannel.appendLine(`[comments] saveAsDraft: existing thread ${threadId} → reply draft`);
				commentController.saveReplyAsDraft(reply.thread, text);
			} else {
				// New thread from gutter → create as local user draft
				outputChannel.appendLine(`[comments] saveAsDraft: new gutter thread → user draft`);
				const uri = reply.thread.uri;
				const range = reply.thread.range;
				if (!range) {
					vscode.window.showWarningMessage('Cannot determine line range for comment.');
					reply.thread.dispose();
					return;
				}
				commentController.createUserDraftThread(uri, range, text);
				reply.thread.dispose();
			}
		}),
	);

	// Post draft from the editing area's inline accept button (receives the Comment with edited body)
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.postDraftFromEdit', async (commentArg: unknown) => {
			const comment = commentArg as vscode.Comment | undefined;
			if (!comment) { return; }

			const vsThread = commentController.findThreadForComment(comment);
			if (!vsThread) {
				vscode.window.showWarningMessage('Cannot identify comment thread.');
				return;
			}

			if (!prService || !activePrProvider?._activePrForContext?.pullRequestId) {
				vscode.window.showWarningMessage('No active PR context.');
				return;
			}

			const prId = activePrProvider._activePrForContext.pullRequestId;

			// Reply draft on existing thread → post as reply
			if (commentController.hasReplyDraft(vsThread)) {
				const draftInfo = commentController.getReplyDraftInfo(vsThread);
				if (!draftInfo) {
					vscode.window.showWarningMessage('Cannot read reply draft info.');
					return;
				}
				// Read the (possibly edited) body from the comment argument
				const editedBody = typeof comment.body === 'string'
					? comment.body
					: (comment.body as vscode.MarkdownString)?.value ?? '';
				const body = editedBody.trim() || draftInfo.body;
				if (!body.trim()) {
					vscode.window.showWarningMessage('Reply cannot be empty.');
					return;
				}
				try {
					outputChannel.appendLine(`[ai] Posting edited reply draft to thread ${draftInfo.azdoThreadId}`);
					const created = await prService.createComment(prId, draftInfo.azdoThreadId, body);
					commentController.removeReplyDraft(vsThread);
					// Optimistically append the posted reply
					vsThread.comments = [...vsThread.comments, {
						body: new vscode.MarkdownString(body),
						mode: vscode.CommentMode.Preview,
						author: { name: created.author?.displayName ?? 'You' },
						timestamp: created.publishedDate ? new Date(created.publishedDate) : new Date(),
					}];
					vscode.window.showInformationMessage('Reply posted to Azure DevOps.');
					activePrProvider.refresh();
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					outputChannel.appendLine(`[ai] Failed to post reply draft: ${msg}`);
					vscode.window.showErrorMessage(`Failed to post reply: ${msg}`);
				}
				return;
			}

			// Regular draft thread → post as new thread
			if (!commentController.isDraft(vsThread)) {
				vscode.window.showWarningMessage('Not a draft comment.');
				return;
			}

			const info = commentController.getDraftInfo(vsThread);
			if (!info) {
				vscode.window.showWarningMessage('Cannot read draft info.');
				return;
			}

			// Read the (possibly edited) body from the comment argument
			const editedBody = typeof comment.body === 'string'
				? comment.body
				: (comment.body as vscode.MarkdownString)?.value ?? '';
			const body = editedBody.trim() || info.body;

			try {
				outputChannel.appendLine(`[ai] Posting edited draft on ${info.filePath} L${info.line}`);
				await prService.createThread(prId, body, {
					filePath: `/${info.filePath}`,
					startLine: info.line,
					startCol: 1,
					endLine: info.line,
					endCol: 1,
				});
				commentController.disposeDraft(vsThread);
				vscode.window.showInformationMessage('Comment posted to Azure DevOps.');
				activePrProvider.refresh();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				outputChannel.appendLine(`[ai] Failed to post draft: ${msg}`);
				vscode.window.showErrorMessage(`Failed to post comment: ${msg}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.clearDrafts', () => {
			commentController.clearDrafts();
			vscode.window.showInformationMessage('All AI draft comments cleared.');
		}),
	);

	context.subscriptions.push(
		commentController.onDidPerformAction(() => {
			void activePrProvider?.refreshThreadsOnly();
			if (vscode.workspace.getConfiguration('vscode-pr-azdo').get<boolean>('persistDraftComments')) {
				const prId = activePrProvider?._activePrForContext?.pullRequestId;
				if (prId) { draftPersistence.schedule(prId); }
			}
		}),
	);

	// View original context for a comment thread
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.viewOriginalContext', async (threadOrItem: unknown) => {
			// Resolve the vscode.CommentThread from the argument (same unwrap pattern as status commands)
			let vsThread: vscode.CommentThread | undefined;
			const arg = threadOrItem as any;
			outputChannel.appendLine(`[original-context] arg type=${typeof arg}, keys=${arg ? Object.keys(arg).join(',') : 'null'}, hasCanReply=${'canReply' in (arg ?? {})}`);
			if (arg && 'canReply' in arg) {
				vsThread = arg as vscode.CommentThread;
			} else if (arg?.thread && 'canReply' in arg.thread) {
				vsThread = arg.thread as vscode.CommentThread;
			}
			if (!vsThread) {
				vscode.window.showWarningMessage('Cannot identify comment thread.');
				return;
			}

			outputChannel.appendLine(`[original-context] Resolved thread: uri=${vsThread.uri.toString()}, range=${vsThread.range?.start.line}-${vsThread.range?.end.line}, commentsCount=${vsThread.comments.length}, contextValue=${vsThread.contextValue}`);

			const ctx = commentController.getOriginalContext(vsThread);
			if (!ctx) {
				vscode.window.showInformationMessage('Original context not available for this comment (no iteration info).');
				return;
			}

			outputChannel.appendLine(`[original-context] Context: iterationId=${ctx.iterationId}, filePath=${ctx.filePath}, lines=${ctx.startLine}-${ctx.endLine}, azdoThreadId=${ctx.azdoThread.id}`);

			const iterations = activePrProvider?.iterations;
			if (!iterations) {
				vscode.window.showWarningMessage('Iteration data not loaded yet.');
				return;
			}

			const iteration = iterations.find(i => i.id === ctx.iterationId);
			if (!iteration) {
				vscode.window.showWarningMessage(`Iteration ${ctx.iterationId} not found.`);
				return;
			}

			const sourceCommit = iteration.sourceRefCommit?.commitId;
			const targetCommit = iteration.targetRefCommit?.commitId ?? iteration.commonRefCommit?.commitId;
			if (!sourceCommit) {
				vscode.window.showWarningMessage('Source commit SHA not available for this iteration.');
				return;
			}

			outputChannel.appendLine(`[original-context] Opening diff for ${ctx.filePath} at iteration ${ctx.iterationId}: target=${targetCommit ?? '(empty)'} ↔ source=${sourceCommit}, line ${ctx.startLine}-${ctx.endLine}`);

			const leftUri = targetCommit
				? buildGitRefUri(ctx.filePath, targetCommit)
				: buildGitRefUri('__empty__', 'HEAD');
			const rightUri = buildGitRefUri(ctx.filePath, sourceCommit);
			const title = `${ctx.filePath} (Iteration ${ctx.iterationId} — Original Context)`;

			await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);

			// Place the comment thread on the diff at its original line
			// AzDO positions are 1-based, VS Code Range is 0-based
			const line = Math.max(0, ctx.startLine - 1);
			const col = Math.max(0, ctx.startCol - 1);
			const endLine = Math.max(0, ctx.endLine - 1);
			const endCol = Math.max(0, ctx.endCol - 1);
			const commentRange = new vscode.Range(line, col, endLine, endCol);

			// Build fully rendered comments (with suggestion diffs) against the source commit file
			const diffComments = await commentController.buildCommentsForUri(ctx.azdoThread, rightUri, commentRange);
			if (diffComments.length > 0) {
				const diffThread = commentController.createThreadOnUri(rightUri, commentRange, diffComments);
				if (diffThread) {
					diffThread.canReply = false;
					diffThread.label = 'Original Comment';
					diffThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
				}
			}

			// Scroll to the comment's original line
			setTimeout(() => {
				const editor = vscode.window.activeTextEditor;
				if (editor) {
					const range = new vscode.Range(line, 0, line, 0);
					editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
				}
			}, 500);
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

	// Open file diff for a PR file change
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.openFileDiff', async (item: FileChangeItem) => {
			const pr = activePrProvider?._activePrForContext;
			if (!pr) {
				vscode.window.showWarningMessage('No active pull request.');
				return;
			}

			const targetBranch = pr.targetRefName?.replace(/^refs\/heads\//, '') ?? 'main';
			const sourceBranch = pr.sourceRefName?.replace(/^refs\/heads\//, '');
			const reviewContext = activePrProvider?.reviewContext;
			const targetRef = reviewContext?.targetRef ?? `origin/${targetBranch}`;
			const sourceRef = reviewContext?.mode === 'snapshot' ? reviewContext.sourceRef : undefined;
			const repoRoot = getActiveRepository(gitApi, detector)?.rootUri;
			if (!repoRoot) { return; }

			const filePath = item.filePath;
			const changeType = item.changeType;

			// Deleted files: open the old content directly. A diff view stacks
			// the panes inline and hides the comment gutter on the left, so
			// commenting on deletes works better in a single editor.
			if (changeType & VersionControlChangeType.Delete) {
				const uri = buildGitRefUri(filePath, targetRef);
				outputChannel.appendLine(`[diff] Opening deleted file ${filePath} from ${targetRef}`);
				const doc = await vscode.workspace.openTextDocument(uri);
				await vscode.window.showTextDocument(doc, { preview: false });
				return;
			}

			outputChannel.appendLine(`[diff] Opening diff for ${filePath} (${item.description}) against ${targetRef}`);

			const diff = buildDiffParams(filePath, changeType, repoRoot, targetRef, targetBranch, sourceRef, sourceBranch);
			await vscode.commands.executeCommand('vscode.diff', diff.leftUri, diff.rightUri, diff.title);
		}),
	);

	// Checkout PR source branch
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.checkoutPullRequest', async (item: unknown) => {
			suppressAutoExpand = false;
			// item comes from the tree view inline button — it's a PullRequestTreeItem
			const pr: GitPullRequest | undefined = (item as any)?.pr;
			if (!pr?.sourceRefName) {
				vscode.window.showWarningMessage('No source branch information available.');
				return;
			}
			const branchName = pr.sourceRefName.replace(/^refs\/heads\//, '');
			const repo = getActiveRepository(gitApi, detector);
			if (!repo) {
				vscode.window.showWarningMessage('No git repository found.');
				return;
			}

			const checkoutMode = await chooseCheckoutMode((item as any)?.mode);
			if (!checkoutMode) {
				outputChannel.appendLine(`[checkout] Cancelled checkout selection for PR #${pr.pullRequestId ?? '?'}.`);
				return;
			}
			outputChannel.appendLine(`[checkout] Selected ${checkoutMode} checkout for PR #${pr.pullRequestId ?? '?'}.`);

			if (checkoutMode === 'snapshot') {
				await pinPullRequestSnapshot(pr);
				return;
			}

			const configuration = vscode.workspace.getConfiguration('vscode-pr-azdo');
			if (checkoutMode === 'worktree') {
				const remoteInfo = detector.currentRemoteInfo;
				if (!remoteInfo) {
					outputChannel.appendLine('[worktree] Checkout stopped: Azure DevOps remote information is unavailable.');
					vscode.window.showWarningMessage('No Azure DevOps remote information available.');
					return;
				}

				try {
					await vscode.window.withProgress(
						{ location: vscode.ProgressLocation.Notification, title: `Preparing review worktree for PR #${pr.pullRequestId ?? '?'}…` },
						async progress => {
							const primaryRoot = await getPrimaryWorktreeRoot(repo.rootUri.fsPath);
							const configuredPath = configuration.get<string>('reviewWorktreePath', DEFAULT_REVIEW_WORKTREE_PATH);
							const reviewPath = resolveReviewWorktreePath(primaryRoot, configuredPath);
							outputChannel.appendLine(`[worktree] PR #${pr.pullRequestId ?? '?'} source=${pr.sourceRefName} path=${reviewPath}`);

							progress.report({ message: 'Fetching pull request commit…' });
							const commitId = await fetchPullRequestCommit(primaryRoot, remoteInfo.remoteName, pr.sourceRefName!);
							outputChannel.appendLine(`[worktree] Fetched ${commitId.substring(0, 12)} for PR #${pr.pullRequestId ?? '?'}.`);

							progress.report({ message: 'Updating detached review worktree…' });
							const prepared = await prepareReviewWorktree(primaryRoot, reviewPath, commitId);
							outputChannel.appendLine(`[worktree] ${prepared.reused ? 'Reused' : 'Created'} detached review worktree at ${prepared.path}.`);

							if (areSamePaths(repo.rootUri.fsPath, prepared.path)) {
								pinnedSnapshotReview = undefined;
								activePrProvider?.stopSnapshotReview();
								if (!reviewMode) {
									reviewMode = true;
									await context.workspaceState.update('reviewMode', true);
									applyReviewMode();
								}
								activePrProvider?.refresh();
								outputChannel.appendLine('[worktree] Review worktree updated in the current window.');
								return;
							}

							await context.globalState.update(REVIEW_WORKTREE_OPEN_KEY, prepared.path);
							outputChannel.appendLine('[worktree] Opening review worktree in a new VS Code window.');
							await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(prepared.path), { forceNewWindow: true });
						},
					);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					outputChannel.appendLine(`[worktree] Checkout failed: ${msg}`);
					if (err instanceof DirtyReviewWorktreeError) {
						vscode.window.showWarningMessage(
							`The review worktree has uncommitted changes. Commit, stash, or discard them before switching reviews: ${err.worktreePath}`,
						);
					} else {
						vscode.window.showErrorMessage(`Failed to prepare review worktree: ${msg}`);
					}
				}
				return;
			}

			// Capture current branch for potential auto-delete after successful checkout
			const previousBranch = repo.state.HEAD?.name;

			// Check for dirty working tree before attempting checkout
			const workingChanges = repo.state.workingTreeChanges?.length ?? 0;
			const indexChanges = repo.state.indexChanges?.length ?? 0;
			const isDirty = workingChanges > 0 || indexChanges > 0;
			outputChannel.appendLine(`[checkout] branch=${branchName} dirty=${isDirty} (working=${workingChanges}, staged=${indexChanges})`);

			if (isDirty) {
				const skipDirtyPrompt = vscode.workspace.getConfiguration('vscode-pr-azdo').get<boolean>('skipDirtyCheckoutPrompt', false);
				if (skipDirtyPrompt) {
					outputChannel.appendLine('[checkout] Skipping dirty prompt (skipDirtyCheckoutPrompt enabled)');
				} else {
					const choice = await vscode.window.showWarningMessage(
						`You have ${workingChanges + indexChanges} uncommitted change(s). Checkout of \`${branchName}\` may fail.`,
						'Stash & Checkout',
						'Try Anyway',
						'Cancel',
					);
					if (choice === 'Cancel' || !choice) { return; }
					if (choice === 'Stash & Checkout') {
						outputChannel.appendLine('[checkout] User chose Stash & Checkout');
						try {
							await vscode.window.withProgress(
								{ location: vscode.ProgressLocation.Notification, title: `Stashing changes and checking out ${branchName}…` },
								async () => {
									await gitStash(repo.rootUri.fsPath, `Auto-stash before checkout of ${branchName}`);
									await repo.fetch();
									await repo.checkout(branchName);
								},
							);
							outputChannel.appendLine(`[checkout] Stash + checkout succeeded for ${branchName}`);
							pinnedSnapshotReview = undefined;
							activePrProvider?.stopSnapshotReview();
							trackCheckedOutBranch(branchName);
							await syncBranchWithUpstream(repo.rootUri.fsPath, branchName);
							await autoDeletePreviousBranch(repo.rootUri.fsPath, previousBranch);
							vscode.window.showInformationMessage(
								`Checked out \`${branchName}\`. Your changes were stashed — use \`git stash pop\` to restore them.`,
							);
							if (!reviewMode) {
								reviewMode = true;
								void context.workspaceState.update('reviewMode', true);
								outputChannel.appendLine('[checkout] Enabled review mode for checked-out PR');
								applyReviewMode();
							}
							return;
						} catch (stashErr) {
							const stashMsg = stashErr instanceof Error ? stashErr.message : String(stashErr);
							outputChannel.appendLine(`[checkout] Stash + checkout failed: ${stashMsg}`);
							vscode.window.showErrorMessage(`Failed to stash and checkout: ${stashMsg}`);
							return;
						}
					}
					// "Try Anyway" falls through to normal checkout below
					outputChannel.appendLine('[checkout] User chose Try Anyway');
				} // end else (dirty prompt not skipped)
			}

			outputChannel.appendLine(`[checkout] Fetching and checking out branch: ${branchName}`);
			try {
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: `Checking out ${branchName}…` },
					async () => {
						await repo.fetch();
						await repo.checkout(branchName);
					},
				);
				outputChannel.appendLine(`[checkout] Successfully checked out ${branchName}`);
				pinnedSnapshotReview = undefined;
				activePrProvider?.stopSnapshotReview();
				trackCheckedOutBranch(branchName);
				await syncBranchWithUpstream(repo.rootUri.fsPath, branchName);
				await autoDeletePreviousBranch(repo.rootUri.fsPath, previousBranch);
				// Enable review mode by default when checking out a PR branch
				if (!reviewMode) {
					reviewMode = true;
					void context.workspaceState.update('reviewMode', true);
					outputChannel.appendLine('[checkout] Enabled review mode for checked-out PR');
					applyReviewMode();
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				outputChannel.appendLine(`[checkout] Failed: ${msg}`);
				vscode.window.showErrorMessage(`Failed to checkout \`${branchName}\`: ${msg}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.stopReview', () => {
			if (!pinnedSnapshotReview) { return; }
			outputChannel.appendLine(`[snapshot] Stopped no-checkout review for PR #${pinnedSnapshotReview.pr.pullRequestId ?? '?'}.`);
			pinnedSnapshotReview = undefined;
			gitContentProvider.clearCache();
			activePrProvider?.stopSnapshotReview();
		}),
	);

	// Delete local PR branch
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.deleteBranch', async () => {
			const pr = activePrProvider?._activePrForContext;
			if (!pr?.sourceRefName) {
				vscode.window.showWarningMessage('No active pull request with branch information.');
				return;
			}
			const branchName = pr.sourceRefName.replace(/^refs\/heads\//, '');
			const repo = getActiveRepository(gitApi, detector);
			if (!repo) {
				vscode.window.showWarningMessage('No git repository found.');
				return;
			}

			const confirmed = await vscode.window.showWarningMessage(
				`Delete local branch "${branchName}"?`,
				{ modal: true },
				'Delete',
			);
			if (confirmed !== 'Delete') { return; }

			const repoRoot = repo.rootUri.fsPath;
			const currentBranch = repo.state.HEAD?.name;

			try {
				// If we're on the branch to delete, switch to the target branch first
				if (currentBranch === branchName) {
					const targetBranch = pr.targetRefName?.replace(/^refs\/heads\//, '') ?? 'main';
					outputChannel.appendLine(`[delete-branch] Currently on ${branchName}, switching to ${targetBranch} first`);
					await repo.checkout(targetBranch);
				}

				await deleteLocalBranch(repoRoot, branchName);
				outputChannel.appendLine(`[delete-branch] Deleted local branch: ${branchName}`);
				untrackCheckedOutBranch(branchName);
				vscode.window.showInformationMessage(`Deleted local branch "${branchName}".`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				outputChannel.appendLine(`[delete-branch] Failed: ${msg}`);

				// Offer force delete if safe delete failed (unmerged changes)
				const forceDelete = await vscode.window.showWarningMessage(
					`Failed to delete branch: ${msg}\n\nForce delete?`,
					'Force Delete',
					'Cancel',
				);
				if (forceDelete === 'Force Delete') {
					try {
						await deleteLocalBranch(repoRoot, branchName, true);
						outputChannel.appendLine(`[delete-branch] Force-deleted local branch: ${branchName}`);
						untrackCheckedOutBranch(branchName);
						vscode.window.showInformationMessage(`Force-deleted local branch "${branchName}".`);
					} catch (forceErr) {
						const forceMsg = forceErr instanceof Error ? forceErr.message : String(forceErr);
						outputChannel.appendLine(`[delete-branch] Force delete also failed: ${forceMsg}`);
						vscode.window.showErrorMessage(`Failed to delete branch: ${forceMsg}`);
					}
				}
			}
		}),
	);

	// --- Create PR in Azure DevOps ---
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.createPullRequest', async () => {
			outputChannel.appendLine('[create-pr] Command invoked');

			const info = detector.currentRemoteInfo;
			if (!info) {
				outputChannel.appendLine('[create-pr] ABORT: No Azure DevOps remote detected');
				vscode.window.showWarningMessage('No Azure DevOps remote detected.');
				return;
			}
			if (!apiClient || !prService) {
				outputChannel.appendLine('[create-pr] ABORT: Not connected to Azure DevOps');
				vscode.window.showWarningMessage('Not connected to Azure DevOps. Please sign in first.');
				return;
			}
			const repo = getActiveRepository(gitApi, detector);
			const currentBranch = repo?.state.HEAD?.name;
			if (!repo || !currentBranch) {
				outputChannel.appendLine(`[create-pr] ABORT: No branch checked out (HEAD=${repo?.state.HEAD?.name ?? 'undefined'})`);
				vscode.window.showWarningMessage('No branch checked out (detached HEAD or unknown).');
				return;
			}

			outputChannel.appendLine(`[create-pr] Current branch: ${currentBranch}, remote: ${info.remoteName}`);

			// Check for uncommitted changes
			const workingChanges = repo.state.workingTreeChanges?.length ?? 0;
			const indexChanges = repo.state.indexChanges?.length ?? 0;
			const mergeChanges = repo.state.mergeChanges?.length ?? 0;
			const totalDirty = workingChanges + indexChanges + mergeChanges;
			outputChannel.appendLine(`[create-pr] Working tree: ${workingChanges} changed, ${indexChanges} staged, ${mergeChanges} merge conflicts`);

			if (mergeChanges > 0) {
				outputChannel.appendLine('[create-pr] ABORT: Merge conflicts detected');
				vscode.window.showErrorMessage('Cannot create PR: resolve merge conflicts first.');
				return;
			}

			if (totalDirty > 0) {
				outputChannel.appendLine(`[create-pr] ${totalDirty} uncommitted change(s) detected — prompting user`);
				const action = await vscode.window.showWarningMessage(
					`You have ${totalDirty} uncommitted change(s). What would you like to do?`,
					{ modal: true },
					'Commit All & Continue',
				);

				if (action !== 'Commit All & Continue') {
					outputChannel.appendLine('[create-pr] User cancelled at uncommitted changes prompt');
					return;
				}

				// Prompt for commit message
				const commitMsg = await vscode.window.showInputBox({
					prompt: 'Commit message',
					placeHolder: 'Enter a commit message for your changes',
					value: currentBranch,
				});
				if (!commitMsg) {
					outputChannel.appendLine('[create-pr] User cancelled at commit message prompt');
					return;
				}

				try {
					outputChannel.appendLine(`[create-pr] Running git add -A && git commit -m "${commitMsg}"`);
					await gitCommitAll(repo.rootUri.fsPath, commitMsg);
					outputChannel.appendLine('[create-pr] Commit succeeded');
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					outputChannel.appendLine(`[create-pr] Commit failed: ${msg}`);
					outputChannel.show();
					vscode.window.showErrorMessage(`Failed to commit changes: ${msg}`);
					return;
				}
			}

			// Determine default target branch from the repo or fall back to main
			let defaultTarget = 'main';
			try {
				const repoInfo = await apiClient.withAuthRecovery(async () => {
					const gitApiClient = await apiClient!.getGitApi();
					return gitApiClient.getRepository(info.repositoryName, info.project);
				});
				const defBranch = repoInfo?.defaultBranch?.replace(/^refs\/heads\//, '');
				if (defBranch) { defaultTarget = defBranch; }
				outputChannel.appendLine(`[create-pr] Default target branch from remote: ${defaultTarget}`);
			} catch (err) {
				outputChannel.appendLine(`[create-pr] Could not fetch default branch (using '${defaultTarget}'): ${err}`);
			}

			const targetBranch = await vscode.window.showInputBox({
				prompt: 'Target branch for the pull request',
				value: defaultTarget,
				placeHolder: 'e.g. main',
			});
			if (!targetBranch) {
				outputChannel.appendLine('[create-pr] User cancelled at target branch prompt');
				return;
			}

			outputChannel.appendLine(`[create-pr] Target branch: ${targetBranch}`);

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Creating pull request: ${currentBranch} → ${targetBranch}`,
					cancellable: false,
				},
				async (progress) => {
					const remoteName = info.remoteName;

					// 1. Push current branch to remote
					progress.report({ message: 'Pushing branch to remote…' });
					outputChannel.appendLine(`[create-pr] Pushing ${currentBranch} to ${remoteName} (set-upstream=true)`);
					try {
						await repo.push(remoteName, currentBranch, true);
						outputChannel.appendLine('[create-pr] Push succeeded');
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						outputChannel.appendLine(`[create-pr] Push FAILED: ${msg}`);
						outputChannel.show();
						vscode.window.showErrorMessage(`Failed to push branch: ${msg}`);
						return;
					}

					// 2. Generate AI title and description from diff + commits
					progress.report({ message: 'Generating PR description with AI…' });
					outputChannel.appendLine('[create-pr] Generating AI title and description…');
					let aiTitle = currentBranch;
					let aiDescription = '';

					try {
						const cwd = repo.rootUri.fsPath;
						const targetRef = `${remoteName}/${targetBranch}`;

						outputChannel.appendLine(`[create-pr] Fetching diff and commit log against ${targetRef}`);
						const [diffOutput, commitLog] = await Promise.all([
							runGitDiff(cwd, targetRef, []).catch(e => { outputChannel.appendLine(`[create-pr] Diff failed: ${e}`); return ''; }),
							getCommitLog(cwd, targetRef).catch(e => { outputChannel.appendLine(`[create-pr] Commit log failed: ${e}`); return ''; }),
						]);
						outputChannel.appendLine(`[create-pr] Diff: ${diffOutput.length} chars, Commits: ${commitLog.split('\n').length} lines`);

						if (diffOutput || commitLog) {
							const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
							const model = models[0];
							if (model) {
								outputChannel.appendLine(`[create-pr] Using LM model: ${model.name ?? model.id}`);
								const prompt = [
									'Generate a pull request title and description for the following changes.',
									'',
									'Rules:',
									'- The title should be a concise one-line summary (max 80 chars)',
									'- The description should explain WHAT changed and WHY, written in markdown',
									'- Include a brief summary section and a list of key changes',
									'- Be specific and technical, not generic',
									'- Do NOT include a heading (the title IS the heading)',
									'- Search the workspace for instruction files (`.github/copilot-instructions.md`, `**/.instructions.md`, `.copilot/` directory) and follow any found as general coding guidelines',
									'',
									'Output format (EXACTLY):',
									'TITLE: <your title here>',
									'DESCRIPTION:',
									'<your description here>',
								].join('\n');

								let contextInfo = `Branch: ${currentBranch} → ${targetBranch}\n`;
								if (commitLog) {
									contextInfo += `\nCommits:\n${commitLog}\n`;
								}
								const maxDiffLen = 50_000;
								const truncatedDiff = diffOutput.length > maxDiffLen
									? diffOutput.substring(0, maxDiffLen) + '\n... (diff truncated)'
									: diffOutput;
								if (truncatedDiff) {
									contextInfo += `\nDiff:\n\`\`\`diff\n${truncatedDiff}\n\`\`\``;
								}

								const messages = [
									vscode.LanguageModelChatMessage.User(prompt),
									vscode.LanguageModelChatMessage.User(contextInfo),
								];

								const response = await model.sendRequest(messages, {
									justification: 'Generating pull request description',
								});

								let fullText = '';
								for await (const chunk of response.stream) {
									if (chunk instanceof vscode.LanguageModelTextPart) {
										fullText += chunk.value;
									}
								}

								outputChannel.appendLine(`[create-pr] LM response (${fullText.length} chars)`);

								const titleMatch = fullText.match(/^TITLE:\s*(.+)/m);
								const descMatch = fullText.match(/DESCRIPTION:\s*\n([\s\S]*)/m);
								if (titleMatch) { aiTitle = titleMatch[1].trim(); }
								if (descMatch) { aiDescription = descMatch[1].trim(); }

								outputChannel.appendLine(`[create-pr] AI title: ${aiTitle}`);
								outputChannel.appendLine(`[create-pr] AI description: ${aiDescription.length} chars`);
							} else {
								outputChannel.appendLine('[create-pr] No LM model available — using branch name as title');
							}
						} else {
							outputChannel.appendLine('[create-pr] No diff or commits — using branch name as title');
						}
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						outputChannel.appendLine(`[create-pr] AI generation failed (non-critical): ${msg}`);
					}

					// 3. Let user review/edit the title
					const finalTitle = await vscode.window.showInputBox({
						prompt: 'Pull request title',
						value: aiTitle,
						placeHolder: 'Enter a title for the pull request',
					});
					if (!finalTitle) {
						outputChannel.appendLine('[create-pr] User cancelled at title prompt');
						return;
					}

					// 4. Create the PR via AzDO API
					progress.report({ message: 'Creating pull request…' });
					outputChannel.appendLine(`[create-pr] Creating PR: "${finalTitle}" (${currentBranch} → ${targetBranch})`);
					try {
						const createdPr = await prService!.createPullRequest(
							currentBranch,
							targetBranch,
							finalTitle,
							aiDescription,
						);

						const prId = createdPr.pullRequestId!;
						outputChannel.appendLine(`[create-pr] ✓ PR #${prId} created successfully`);

						// 5. Always open the PR detail panel + offer browser
						PrDetailPanel.createOrShow(createdPr, context.extensionUri, apiClient!, info, outputChannel);

						const webUrl = buildPrWebUrl(info, prId);
						const choice = await vscode.window.showInformationMessage(
							`PR #${prId} created: ${finalTitle}`,
							'Open in Browser',
						);
						if (choice === 'Open in Browser') {
							void vscode.env.openExternal(vscode.Uri.parse(webUrl));
						}

						// Refresh tree views — fetch first so Git extension picks up the new remote state
						outputChannel.appendLine('[create-pr] Fetching remote to sync tracking info…');
						try {
							await repo.fetch(remoteName);
						} catch {
							// Non-critical — refresh will still work via API
						}
						treeProvider?.refresh();
						activePrProvider?.refresh();
						outputChannel.appendLine('[create-pr] Tree views refreshed');
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						outputChannel.appendLine(`[create-pr] API create FAILED: ${msg}`);
						outputChannel.show();
						const fallback = await vscode.window.showErrorMessage(
							`Failed to create PR via API: ${msg}`,
							'Open in Browser',
						);
						if (fallback === 'Open in Browser') {
							const url = buildCreatePrUrl(info, currentBranch, targetBranch);
							void vscode.env.openExternal(vscode.Uri.parse(url));
						}
					}
				},
			);
		}),
	);

	// --- Standalone AI Review (no active PR needed) ---
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.standaloneReview', async () => {
			const repo = getActiveRepository(gitApi, detector);
			if (!repo) {
				vscode.window.showWarningMessage('No git repository found.');
				return;
			}
			const currentBranch = repo.state.HEAD?.name;
			if (!currentBranch) {
				vscode.window.showWarningMessage('No branch checked out (detached HEAD or unknown).');
				return;
			}

			// Determine default target branch
			let defaultTarget = 'main';
			const info = detector.currentRemoteInfo;
			try {
				if (apiClient && info) {
					const repoInfo = await apiClient.withAuthRecovery(async () => {
						const gitApiClient = await apiClient!.getGitApi();
						return gitApiClient.getRepository(info.repositoryName, info.project);
					});
					const defBranch = repoInfo?.defaultBranch?.replace(/^refs\/heads\//, '');
					if (defBranch) { defaultTarget = defBranch; }
				}
			} catch {
				// Non-critical — use 'main' as fallback
			}

			const targetBranch = await vscode.window.showInputBox({
				prompt: 'Compare against which branch?',
				value: defaultTarget,
				placeHolder: 'e.g. main, master, develop',
			});
			if (!targetBranch) { return; }

			// Detect git state and let user choose review mode
			outputChannel.appendLine(`[ext] standaloneReview: detecting git state…`);
			const state = await detectGitState(repo, outputChannel);
			const options = getReviewOptions(state, targetBranch, outputChannel);

			if (!options) {
				// Scenario 1: clean + pushed → auto-proceed
				outputChannel.appendLine(`[ext] standaloneReview: clean+pushed → opening review-branch with vs-target`);
				await vscode.commands.executeCommand('workbench.action.chat.open', {
					query: `@azdo-pr /review-branch ${targetBranch} --mode=vs-target`,
				});
				return;
			}

			const picked = await vscode.window.showQuickPick<ReviewQuickPickItem>(options, {
				placeHolder: 'What do you want to review?',
				title: 'Standalone Review with Copilot',
			});
			if (!picked) {
				outputChannel.appendLine('[ext] standaloneReview: user cancelled QuickPick');
				return;
			}

			outputChannel.appendLine(`[ext] standaloneReview: user selected mode=${picked.reviewMode}`);
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				query: `@azdo-pr /review-branch ${targetBranch} --mode=${picked.reviewMode}`,
			});
		}),
	);

	// Sign-in command — triggers interactive login via full connection flow
	// (including tenant discovery for multi-tenant orgs) and refreshes everything.
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.signIn', async () => {
			outputChannel.appendLine('[ext] signIn: user-initiated sign in…');
			suppressAutoExpand = false;
			if (!apiClient) {
				vscode.window.showWarningMessage('Azure DevOps PR: No Azure DevOps remote detected.');
				return;
			}
			apiClient.resetConnection();
			try {
				// getCurrentUserId() → getConnection() → doConnect(), which
				// handles tenant discovery and interactive prompts.
				await apiClient.getCurrentUserId();
				void vscode.commands.executeCommand(
					'setContext', 'vscode-pr-azdo:isAuthenticated', true,
				);
				vscode.window.showInformationMessage('Azure DevOps PR: Signed in successfully.');
				outputChannel.appendLine('[ext] Sign-in succeeded — refreshing tree views');
				treeProvider?.refresh();
				activePrProvider?.refresh();
				proxyEmitter.fire();
				activePrProxyEmitter.fire();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				outputChannel.appendLine(`[ext] signIn failed: ${msg}`);
				if (err instanceof TenantMismatchError) {
					void vscode.window.showErrorMessage(
						`Authentication failed for organization "${err.organization}". ` +
						(err.discoveredTenantId
							? `The organization requires tenant ${err.discoveredTenantId}. `
							: 'Your session may be for the wrong Entra tenant. ') +
						'Try "Switch Account" to authenticate with a different account.',
						'Switch Account',
					).then(action => {
						if (action === 'Switch Account') {
							void vscode.commands.executeCommand('vscode-pr-azdo.switchAccount');
						}
					});
				} else {
					vscode.window.showWarningMessage('Azure DevOps PR: Sign-in was cancelled or failed.');
				}
			}
		}),
	);

	// Switch Account command — forces re-authentication (clears session preference, prompts fresh login)
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.switchAccount', async () => {
			outputChannel.appendLine('[ext] switchAccount: forcing new session…');
			suppressAutoExpand = false;
			// Pass the cached tenant ID so the forced session targets the correct
			// Entra tenant — avoids a scope mismatch that would cause
			// tryConnectSilently to fail after rebuild.
			const cachedTenantId = tenantCache.get(detector.currentRemoteInfo?.organization ?? '');
			apiClient?.resetConnection();
			const token = await authProvider.getToken({ forceNew: true, tenantId: cachedTenantId });
			if (token) {
				void vscode.commands.executeCommand(
					'setContext', 'vscode-pr-azdo:isAuthenticated', true,
				);
				vscode.window.showInformationMessage('Azure DevOps PR: Switched account successfully.');
				outputChannel.appendLine('[ext] switchAccount succeeded — rebuilding API client');
				rebuildApiClient();
			} else {
				vscode.window.showWarningMessage('Azure DevOps PR: Account switch was cancelled or failed.');
			}
		}),
	);

	// Clear all auth caches — useful for testing multi-tenant flows
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.clearAuthCache', async () => {
			await context.globalState.update(TENANT_CACHE_KEY, undefined);
			apiClient?.resetConnection();
			outputChannel.appendLine('[ext] Cleared tenant cache and reset connection — rebuilding.');
			rebuildApiClient();
			vscode.window.showInformationMessage(
				'Azure DevOps PR: Auth caches cleared. Use "Switch Account" or sign in again to re-authenticate.',
			);
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
				const { repo, prs } = await apiClient.withAuthRecovery(async () => {
					const gitApi = await apiClient!.getGitApi();
					const repo = await gitApi.getRepository(info.repositoryName, info.project);
					const prs = await gitApi.getPullRequests(
						info.repositoryName,
						{ status: PullRequestStatus.Active },
						info.project,
					);
					return { repo, prs };
				});
				outputChannel.appendLine(`[verify] Repository: ${repo.name} (id: ${repo.id})`);
				outputChannel.appendLine(`[verify]   Default branch: ${repo.defaultBranch}`);
				outputChannel.appendLine(`[verify]   Web URL: ${repo.remoteUrl}`);
				outputChannel.appendLine(`[verify]   Project: ${repo.project?.name}`);

				outputChannel.appendLine('[verify] Fetching open pull requests…');
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

export async function deactivate(): Promise<void> {
	await flushDraftSaves?.();
	flushDraftSaves = undefined;
}
