import * as vscode from 'vscode';
import type { GitPullRequest, GitCommitRef, GitPullRequestChange, GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { VersionControlChangeType, CommentType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { hasSuggestion, extractSuggestion, extractCommentText } from './suggestionRenderer';

// ---------------------------------------------------------------------------
// Active PR root
// ---------------------------------------------------------------------------

export class ActivePrRootItem extends vscode.TreeItem {
    constructor(public readonly pr: GitPullRequest) {
        super(pr.title ?? '(untitled)', vscode.TreeItemCollapsibleState.Expanded);
        this.description = `#${pr.pullRequestId}`;
        this.iconPath = new vscode.ThemeIcon(
            pr.isDraft ? 'git-pull-request-draft' : 'git-pull-request',
        );
        this.contextValue = 'activePr';
        this.command = {
            command: 'vscode-pr-azdo.openPullRequest',
            title: 'Open Pull Request',
            arguments: [pr],
        };
    }
}

// ---------------------------------------------------------------------------
// Review mode toggle (root-level clickable item)
// ---------------------------------------------------------------------------

export class ReviewModeToggleItem extends vscode.TreeItem {
    constructor(reviewMode: boolean, threadCount: number) {
        const label = reviewMode ? 'Disable Review' : 'Enable Review';
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = threadCount > 0 ? `${threadCount} thread${threadCount === 1 ? '' : 's'}` : '';
        this.iconPath = new vscode.ThemeIcon(reviewMode ? 'eye' : 'eye-closed');
        this.contextValue = 'activePr.reviewModeToggle';
        this.tooltip = reviewMode
            ? 'Click to disable review mode — hides comments and disables new comments'
            : 'Click to enable review mode — shows comments and allows adding new ones';
        this.command = {
            command: 'vscode-pr-azdo.toggleReviewMode',
            title: 'Toggle Review Mode',
        };
    }
}

// ---------------------------------------------------------------------------
// Section headers (Files / Commits)
// ---------------------------------------------------------------------------

export type ActivePrSection = 'files' | 'commits';

export class SectionHeaderItem extends vscode.TreeItem {
    constructor(
        public readonly section: ActivePrSection,
        label: string,
        count: number,
    ) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.description = `${count}`;
        this.iconPath = new vscode.ThemeIcon(
            section === 'files' ? 'files' : 'git-commit',
        );
        this.contextValue = `activePr.${section}`;
    }
}

// ---------------------------------------------------------------------------
// File tree nodes
// ---------------------------------------------------------------------------

export class FolderItem extends vscode.TreeItem {
    readonly children: (FolderItem | FileChangeItem)[] = [];

    constructor(public readonly folderName: string) {
        super(folderName, vscode.TreeItemCollapsibleState.Collapsed);
        this.iconPath = vscode.ThemeIcon.Folder;
        this.contextValue = 'activePr.folder';
        this.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
    }
}

export class FileChangeItem extends vscode.TreeItem {
    readonly commentThreads: (CommentThreadItem | DraftCommentItem)[] = [];

    constructor(
        public readonly fileName: string,
        public readonly filePath: string,
        public readonly changeType: VersionControlChangeType,
    ) {
        super(fileName, vscode.TreeItemCollapsibleState.None);
        this.description = changeTypeLabel(changeType);
        this.iconPath = iconForChangeType(changeType);
        this.resourceUri = vscode.Uri.parse(`file:///${filePath}`);
        this.contextValue = 'activePr.file';
        this.tooltip = `${filePath} (${changeTypeLabel(changeType)})`;
        this.checkboxState = vscode.TreeItemCheckboxState.Unchecked;

        // Click opens the diff view
        this.command = {
            command: 'vscode-pr-azdo.openFileDiff',
            title: 'Show Changes',
            arguments: [this],
        };
    }

    /** Call after adding comment threads to update collapsible state. */
    finalizeComments(): void {
        if (this.commentThreads.length > 0) {
            this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        }
    }
}

// ---------------------------------------------------------------------------
// Comment thread node
// ---------------------------------------------------------------------------

/**
 * Represents the first comment of a thread on a file or at PR level.
 */
export class CommentThreadItem extends vscode.TreeItem {
    constructor(public readonly thread: GitPullRequestCommentThread) {
        const firstComment = thread.comments?.find(c => !c.isDeleted && c.commentType !== CommentType.System);
        const author = firstComment?.author?.displayName ?? 'unknown';
        const content = firstComment?.content ?? '(no content)';

        // For suggestions, show a cleaner label
        let displayText: string;
        let tooltipMd: string;
        if (hasSuggestion(content)) {
            const commentText = extractCommentText(content);
            const suggested = extractSuggestion(content) ?? '';
            displayText = commentText || '💡 Suggestion';
            tooltipMd = `**${author}** — 💡 Suggestion\n\n`;
            if (commentText) {
                tooltipMd += commentText + '\n\n';
            }
            tooltipMd += '```diff\n+ ' + suggested.split('\n').join('\n+ ') + '\n```';
        } else {
            displayText = content;
            tooltipMd = `**${author}**\n\n${content}`;
        }

        const truncated = displayText.length > 80 ? displayText.substring(0, 77) + '…' : displayText;

        super(truncated, vscode.TreeItemCollapsibleState.None);
        this.description = author;
        this.iconPath = new vscode.ThemeIcon(hasSuggestion(content) ? 'lightbulb' : 'comment');
        this.contextValue = 'activePr.comment';
        this.tooltip = new vscode.MarkdownString(tooltipMd);

        // Click navigates to the comment location
        const filePath = thread.threadContext?.filePath;
        const line = thread.threadContext?.rightFileStart?.line ?? 1;
        if (filePath) {
            this.command = {
                command: 'vscode-pr-azdo.goToComment',
                title: 'Go to Comment',
                arguments: [filePath.startsWith('/') ? filePath.substring(1) : filePath, line],
            };
        } else {
            // PR-level comment — open the virtual PR Comments document
            this.command = {
                command: 'vscode-pr-azdo.openPrComments',
                title: 'View PR Comments',
            };
        }
    }
}

// ---------------------------------------------------------------------------
// Draft comment node (local-only drafts shown in the tree)
// ---------------------------------------------------------------------------

/**
 * Represents a local draft comment (user or AI) in the sidebar tree.
 */
export class DraftCommentItem extends vscode.TreeItem {
    constructor(
        public readonly filePath: string,
        public readonly line: number,
        content: string,
        public readonly kind: 'user' | 'ai' | 'reply',
    ) {
        const truncated = content.length > 80 ? content.substring(0, 77) + '…' : content;
        const kindLabel = kind === 'ai' ? '✨ AI Draft' : '📝 Draft';
        super(truncated, vscode.TreeItemCollapsibleState.None);
        this.description = kindLabel;
        this.iconPath = new vscode.ThemeIcon(kind === 'ai' ? 'sparkle' : 'bookmark');
        this.contextValue = 'activePr.draft';
        this.tooltip = new vscode.MarkdownString(`**${kindLabel}** — ${filePath}:${line}\n\n${content}`);

        this.command = {
            command: 'vscode-pr-azdo.goToComment',
            title: 'Go to Draft',
            arguments: [filePath, line],
        };
    }
}

// ---------------------------------------------------------------------------
// Commit node
// ---------------------------------------------------------------------------

export class CommitItem extends vscode.TreeItem {
    constructor(public readonly commit: GitCommitRef) {
        const shortSha = (commit.commitId ?? '').substring(0, 7);
        const msg = commit.comment?.split('\n')[0] ?? '(no message)';
        super(msg, vscode.TreeItemCollapsibleState.None);
        this.description = shortSha;
        this.iconPath = new vscode.ThemeIcon('git-commit');
        this.contextValue = 'activePr.commit';
        this.tooltip = `${shortSha} — ${commit.author?.name ?? 'unknown'}\n${commit.comment ?? ''}`;
    }
}

// ---------------------------------------------------------------------------
// Union type for the provider
// ---------------------------------------------------------------------------

export type ActivePrTreeItem =
    | ActivePrRootItem
    | ReviewModeToggleItem
    | SectionHeaderItem
    | FolderItem
    | FileChangeItem
    | CommentThreadItem
    | DraftCommentItem
    | CommitItem;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function changeTypeLabel(ct: VersionControlChangeType): string {
    // The enum is a bitmask — check the most meaningful flag
    if (ct & VersionControlChangeType.Add) { return 'Add'; }
    if (ct & VersionControlChangeType.Delete) { return 'Delete'; }
    if (ct & VersionControlChangeType.Rename) { return 'Rename'; }
    if (ct & VersionControlChangeType.Edit) { return 'Edit'; }
    if (ct & VersionControlChangeType.Merge) { return 'Merge'; }
    return '';
}

/**
 * Pick a themed icon for a file change so adds/deletes/renames are visually
 * distinct from edits in the tree.
 */
export function iconForChangeType(ct: VersionControlChangeType): vscode.ThemeIcon {
    if (ct & VersionControlChangeType.Delete) {
        return new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
    }
    if (ct & VersionControlChangeType.Add) {
        return new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
    }
    if (ct & VersionControlChangeType.Rename) {
        return new vscode.ThemeIcon('diff-renamed', new vscode.ThemeColor('gitDecoration.renamedResourceForeground'));
    }
    return vscode.ThemeIcon.File;
}

/**
 * Extract the repo-relative file path for a PR change entry.
 *
 * AzDO returns different shapes per change type:
 * - Edit / Add: path is on `item.path` (e.g. "/src/index.ts")
 * - Delete: `item.path` is `null` and the path is on the top-level `originalPath`
 * - Rename: `item.path` is the new path, top-level `originalPath` is the old path
 *
 * Returns the path WITHOUT a leading slash, or `undefined` if neither field
 * yields a usable path.
 */
export function getChangePath(change: GitPullRequestChange): string | undefined {
    const ch = change as any;
    const raw = (typeof ch.item?.path === 'string' && ch.item.path)
        || (typeof ch.originalPath === 'string' && ch.originalPath)
        || undefined;
    if (!raw) { return undefined; }
    return raw.startsWith('/') ? raw.substring(1) : raw;
}

/**
 * Build a folder tree from a flat list of file changes.
 * Single-child intermediate folders are compacted ("src/components" instead
 * of separate "src" → "components" nodes).
 */
export function buildFileTree(changes: GitPullRequestChange[]): (FolderItem | FileChangeItem)[] {
    // Build a nested map-based tree
    interface FolderNode {
        children: Map<string, FolderNode>;
        files: { name: string; path: string; changeType: VersionControlChangeType }[];
    }
    const root: FolderNode = { children: new Map(), files: [] };

    for (const change of changes) {
        const path = getChangePath(change);
        if (!path) { continue; }

        const parts = path.split('/');
        const fileName = parts.pop()!;

        let current = root;
        for (const part of parts) {
            if (!current.children.has(part)) {
                current.children.set(part, { children: new Map(), files: [] });
            }
            current = current.children.get(part)!;
        }
        current.files.push({
            name: fileName,
            path,
            changeType: (change as any).changeType ?? VersionControlChangeType.None,
        });
    }

    // Convert the map tree to TreeItem tree, compacting single-child folders
    function convertChildren(node: FolderNode): (FolderItem | FileChangeItem)[] {
        const result: (FolderItem | FileChangeItem)[] = [];

        for (const [name, child] of node.children) {
            // Compact: if folder has no files and exactly one subfolder, merge names
            let compactedName = name;
            let current = child;
            while (current.files.length === 0 && current.children.size === 1) {
                const [nextName, nextChild] = [...current.children.entries()][0];
                compactedName += '/' + nextName;
                current = nextChild;
            }

            const folder = new FolderItem(compactedName);
            // Recurse into subfolders of the (possibly compacted) node
            folder.children.push(...convertChildren(current));
            // Add leaf files from this (possibly compacted) folder
            for (const f of current.files) {
                folder.children.push(new FileChangeItem(f.name, f.path, f.changeType));
            }
            result.push(folder);
        }

        return result;
    }

    // Build from root: subfolders first, then root-level files
    const result = convertChildren(root);
    for (const f of root.files) {
        result.push(new FileChangeItem(f.name, f.path, f.changeType));
    }
    return result;
}
