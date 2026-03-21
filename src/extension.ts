import * as vscode from 'vscode';
import { getGitAPI, deleteLocalBranch, getCommitLog, gitCommitAll, gitStash } from './git/gitExtension';
import { RepositoryDetector } from './azdo/repositoryDetector';
import { EntraIdAuthProvider } from './azdo/auth/entraIdAuthProvider';
import { AzDoApiClient } from './azdo/apiClient';
import { PullRequestService } from './azdo/prService';
import { PrTreeDataProvider, type PrTreeItem } from './views/prTreeDataProvider';
import { PullRequestTreeItem } from './views/prTreeItems';
import { ActivePrTreeDataProvider } from './views/activePrTreeDataProvider';
import { FileChangeItem, FolderItem, ActivePrRootItem, SectionHeaderItem, type ActivePrTreeItem } from './views/activePrTreeItems';
import { PrDetailPanel, buildCreatePrUrl, buildPrWebUrl } from './views/prDetailPanel';
import { PrCommentController, PR_COMMENTS_SCHEME } from './views/prCommentController';
import { GitRefContentProvider, GIT_CONTENT_SCHEME, buildGitRefUri } from './views/gitRefContentProvider';
import { VersionControlChangeType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { PullRequestStatus, CommentThreadStatus, type GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { PrContextProvider } from './chat/prContextProvider';
import { registerPrChatParticipant, DEFAULT_SYSTEM_PROMPT, DEFAULT_REVIEW_PROMPT, DEFAULT_REVIEW_QUICK_PROMPT, runGitDiff } from './chat/prChatParticipant';
import { registerPrTools } from './chat/prTools';
import { detectGitState, getReviewOptions, type ReviewQuickPickItem } from './git/gitStateDetector';

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
	let currentUserId: string | undefined;
	let treeProvider: PrTreeDataProvider | undefined;
	let treeProviderSub: vscode.Disposable | undefined;
	let activePrProvider: ActivePrTreeDataProvider | undefined;
	let activePrProviderSub: vscode.Disposable | undefined;
	let activePrCommentSub: vscode.Disposable | undefined;
	let activePrTreeView: vscode.TreeView<ActivePrTreeItem> | undefined;

	// Inline comment controller — lives for the extension's lifetime
	const commentController = new PrCommentController(outputChannel, gitApi);
	context.subscriptions.push(commentController);

	// --- AI Chat Participant & Context Provider ---
	const prContextProvider = new PrContextProvider();
	registerPrChatParticipant(context, prContextProvider, commentController, outputChannel, gitApi);
	registerPrTools(context, prContextProvider, outputChannel, gitApi);

	// --- Review Mode ---
	let reviewMode = context.workspaceState.get<boolean>('reviewMode', false);

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
			await deleteLocalBranch(repoRoot, previousBranch);
			untrackCheckedOutBranch(previousBranch);
			outputChannel.appendLine(`[auto-delete] Deleted "${previousBranch}"`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			outputChannel.appendLine(`[auto-delete] Failed to delete "${previousBranch}": ${msg}`);
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

	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.toggleReviewMode', () => {
			reviewMode = !reviewMode;
			void context.workspaceState.update('reviewMode', reviewMode);
			outputChannel.appendLine(`[ext] Review mode toggled: ${reviewMode}`);
			applyReviewMode();
		}),
	);

	// Git ref content provider for diff views
	const gitContentProvider = new GitRefContentProvider(outputChannel, gitApi);
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

			// Fetch user ID early — needed to identify own comments for delete button.
			// Don't await here to avoid blocking tree view setup; wire up comments after it resolves.
			const userIdPromise = apiClient.getCurrentUserId().catch(() => undefined);

			prService = new PullRequestService(apiClient, info);
			treeProvider = new PrTreeDataProvider(prService, apiClient, outputChannel);
			context.subscriptions.push(treeProvider);

			activePrProvider = new ActivePrTreeDataProvider(prService, gitApi!, outputChannel);
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
				updateReviewModeUi(hasActivePr);

				// Restore persisted reviewed-files state for the newly active PR
				const prId = activePrProvider?._activePrForContext?.pullRequestId;
				if (prId && activePrProvider!.reviewedFiles.size === 0) {
					const persisted = context.workspaceState.get<string[]>(`reviewedFiles-${prId}`);
					if (persisted && persisted.length > 0) {
						activePrProvider!.setReviewedFiles(persisted);
						outputChannel.appendLine(`[reviewed] Restored ${persisted.length} reviewed file(s) for PR #${prId}`);
					}
				}

				activePrProxyEmitter.fire();

				// Auto-expand the tree when a new PR becomes active
				if (prId && prId !== lastExpandedPrId) {
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
				void userIdPromise.then(uid => {
					currentUserId = uid;
					const pr = activePrProvider?._activePrForContext;
					commentController.setPrContext(
						prService,
						pr?.pullRequestId,
						activePrProvider?.changedFilePaths,
						currentUserId,
					);
					commentController.updateThreads(activePrProvider?.filteredThreads);
					// Keep AI context provider in sync
					prContextProvider.setActivePr(pr, activePrProvider?.changedFilePaths, activePrProvider?.iterations);
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
		vscode.commands.registerCommand('vscode-pr-azdo.refreshPullRequests', () => {
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
				void context.workspaceState.update(`reviewedFiles-${prId}`, reviewed);
				outputChannel.appendLine(`[reviewed] Persisted ${reviewed.length} reviewed file(s) for PR #${prId}`);
			}
		}),
	);

	// Refresh active PR command
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.refreshActivePr', () => {
			activePrProvider?.refresh();
			gitContentProvider.clearCache();
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
			const repoRoot = gitApi?.repositories[0]?.rootUri;
			if (!repoRoot) { return; }
			const fileUri = vscode.Uri.joinPath(repoRoot, filePath);
			const doc = await vscode.workspace.openTextDocument(fileUri);
			const editor = await vscode.window.showTextDocument(doc);
			const pos = new vscode.Position(Math.max(0, line - 1), 0);
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
			if (!reply) { return; }

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
				await commentController.handleReply(reply);
			} else {
				// New thread from gutter
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
			outputChannel.appendLine('[ai] Opening Copilot Edits to apply suggestion');
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				query: 'Apply the suggestion',
			});
		}),
	);

	// --- AI: Review PR from sidebar button ---
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.reviewWithAI', async () => {
			outputChannel.appendLine('[ai] reviewWithAI: detecting git state…');
			const repo = gitApi?.repositories[0];
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

	// Refresh comment controller when a comment action is performed
	context.subscriptions.push(
		commentController.onDidPerformAction(() => {
			activePrProvider?.refresh();
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
			const targetRef = `origin/${targetBranch}`;
			const repoRoot = gitApi?.repositories[0]?.rootUri;
			if (!repoRoot) { return; }

			const filePath = item.filePath;
			const changeType = item.changeType;

			outputChannel.appendLine(`[diff] Opening diff for ${filePath} (${item.description}) against ${targetRef}`);

			let leftUri: vscode.Uri;
			let rightUri: vscode.Uri;
			let title: string;

			if (changeType & VersionControlChangeType.Add) {
				// New file: left is empty, right is working copy
				leftUri = buildGitRefUri('__empty__', targetRef);
				rightUri = vscode.Uri.joinPath(repoRoot, filePath);
				title = `${item.fileName} (Added)`;
			} else if (changeType & VersionControlChangeType.Delete) {
				// Deleted file: left is target branch, right is empty
				leftUri = buildGitRefUri(filePath, targetRef);
				rightUri = buildGitRefUri('__empty__', targetRef);
				title = `${item.fileName} (Deleted)`;
			} else {
				// Edit/Rename/etc: left is target branch, right is working copy
				leftUri = buildGitRefUri(filePath, targetRef);
				rightUri = vscode.Uri.joinPath(repoRoot, filePath);
				title = `${item.fileName} (${targetBranch} ↔ Working Copy)`;
			}

			await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
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

			// Capture current branch for potential auto-delete after successful checkout
			const previousBranch = repo.state.HEAD?.name;

			// Check for dirty working tree before attempting checkout
			const workingChanges = repo.state.workingTreeChanges?.length ?? 0;
			const indexChanges = repo.state.indexChanges?.length ?? 0;
			const isDirty = workingChanges > 0 || indexChanges > 0;
			outputChannel.appendLine(`[checkout] branch=${branchName} dirty=${isDirty} (working=${workingChanges}, staged=${indexChanges})`);

			if (isDirty) {
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
						trackCheckedOutBranch(branchName);
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
				trackCheckedOutBranch(branchName);
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

	// Delete local PR branch
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-pr-azdo.deleteBranch', async () => {
			const pr = activePrProvider?._activePrForContext;
			if (!pr?.sourceRefName) {
				vscode.window.showWarningMessage('No active pull request with branch information.');
				return;
			}
			const branchName = pr.sourceRefName.replace(/^refs\/heads\//, '');
			const repo = gitApi?.repositories[0];
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
			const repo = gitApi?.repositories[0];
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
				const gitApiClient = await apiClient.getGitApi();
				const repoInfo = await gitApiClient.getRepository(info.repositoryName, info.project);
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
			const repo = gitApi?.repositories[0];
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
					const gitApiClient = await apiClient.getGitApi();
					const repoInfo = await gitApiClient.getRepository(info.repositoryName, info.project);
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
