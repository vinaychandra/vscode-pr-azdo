import * as vscode from 'vscode';
import { VersionControlChangeType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { GIT_CONTENT_SCHEME, buildGitRefUri } from './gitRefContentProvider';

/**
 * Compute a repo-relative path from a file URI and a repo root URI.
 * Returns `undefined` if the file is not under the repo root.
 */
export function computeRelativePath(fileUri: vscode.Uri, repoRootUri: vscode.Uri): string | undefined {
    const rootPath = repoRootUri.path;
    const filePath = fileUri.path;
    const isWindowsPath = /^\/[a-z]:\//i.test(rootPath);
    const comparableRoot = isWindowsPath ? rootPath.toLowerCase() : rootPath;
    const comparableFile = isWindowsPath ? filePath.toLowerCase() : filePath;
    if (comparableFile.startsWith(comparableRoot + '/')) {
        return filePath.substring(rootPath.length + 1);
    }
    return undefined;
}

/**
 * Extract the repo-relative file path from a git-ref content URI.
 * Returns `undefined` for `__empty__` paths.
 */
export function extractPathFromGitRefUri(uri: vscode.Uri): string | undefined {
    const p = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
    return p === '__empty__' ? undefined : p;
}

/** Return the workspace file shown by a text diff, regardless of which side is focused. */
export function getWorkspaceFileUriFromDiffInput(input: unknown): vscode.Uri | undefined {
    if (!(input instanceof vscode.TabInputTextDiff)) {
        return undefined;
    }
    if (input.modified.scheme === 'file') {
        return input.modified;
    }
    return input.original.scheme === 'file' ? input.original : undefined;
}

/**
 * Check if a URI (file or git-ref scheme) belongs to a set of changed file paths.
 */
export function isUriInChangedFiles(uri: vscode.Uri, repoRootUri: vscode.Uri | undefined, changedPaths: string[]): boolean {
    if (uri.scheme === 'file' && repoRootUri) {
        const relative = computeRelativePath(uri, repoRootUri);
        return relative !== undefined && changedPaths.includes(relative);
    }
    if (uri.scheme === GIT_CONTENT_SCHEME) {
        const p = extractPathFromGitRefUri(uri);
        return p !== undefined && changedPaths.includes(p);
    }
    return false;
}

/** The result of building diff parameters. */
export interface DiffParams {
    leftUri: vscode.Uri;
    rightUri: vscode.Uri;
    title: string;
}

/**
 * Build the left/right URIs and title for a diff view.
 *
 * @param relativePath Repo-relative path of the file
 * @param changeType   The type of change (Add/Delete/Edit/etc.)
 * @param repoRootUri  The URI of the repo root (for working-copy files)
 * @param targetRef    The git ref to diff against (e.g. `origin/main`)
 * @param targetBranch The display name of the target branch (e.g. `main`)
 */
export function buildDiffParams(
    relativePath: string,
    changeType: VersionControlChangeType,
    repoRootUri: vscode.Uri,
    targetRef: string,
    targetBranch: string,
): DiffParams {
    const fileName = relativePath.split('/').pop() ?? relativePath;

    if (changeType & VersionControlChangeType.Add) {
        return {
            leftUri: buildGitRefUri('__empty__', targetRef),
            rightUri: vscode.Uri.joinPath(repoRootUri, relativePath),
            title: `${fileName} (Added)`,
        };
    }
    if (changeType & VersionControlChangeType.Delete) {
        return {
            leftUri: buildGitRefUri(relativePath, targetRef),
            rightUri: buildGitRefUri('__empty__', targetRef),
            title: `${fileName} (Deleted)`,
        };
    }
    return {
        leftUri: buildGitRefUri(relativePath, targetRef),
        rightUri: vscode.Uri.joinPath(repoRootUri, relativePath),
        title: `${fileName} (${targetBranch} ↔ Working Copy)`,
    };
}
