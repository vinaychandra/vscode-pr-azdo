import * as vscode from 'vscode';
import type { GitPullRequest, GitCommitRef, GitPullRequestChange } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { VersionControlChangeType } from 'azure-devops-node-api/interfaces/GitInterfaces';

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
    }
}

export class FileChangeItem extends vscode.TreeItem {
    constructor(
        public readonly fileName: string,
        public readonly filePath: string,
        public readonly changeType: VersionControlChangeType,
    ) {
        super(fileName, vscode.TreeItemCollapsibleState.None);
        this.description = changeTypeLabel(changeType);
        this.iconPath = vscode.ThemeIcon.File;
        this.resourceUri = vscode.Uri.parse(`file:///${filePath}`);
        this.contextValue = 'activePr.file';
        this.tooltip = `${filePath} (${changeTypeLabel(changeType)})`;
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
    | SectionHeaderItem
    | FolderItem
    | FileChangeItem
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
        const rawPath = (change as any).item?.path as string | undefined;
        if (!rawPath) { continue; }

        const path = rawPath.startsWith('/') ? rawPath.substring(1) : rawPath;
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
