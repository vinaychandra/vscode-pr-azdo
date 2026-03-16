import * as vscode from 'vscode';
import { execFile } from 'child_process';
import type { API } from '../typings/git';

/**
 * URI scheme for showing file content at a specific git ref.
 *
 * URI format:
 *   azdo-pr-git:///{filePath}?ref={gitRef}
 *
 * Example:
 *   azdo-pr-git:///src/index.ts?ref=origin/main
 */
export const GIT_CONTENT_SCHEME = 'azdo-pr-git';

/**
 * Provides readonly document content by running `git show {ref}:{path}`
 * against the local repository.
 */
export class GitRefContentProvider implements vscode.TextDocumentContentProvider {
    private _cache = new Map<string, string>();

    constructor(
        private readonly log: vscode.OutputChannel,
        private readonly gitApi?: API,
    ) { }

    async provideTextDocumentContent(uri: vscode.Uri, _token: vscode.CancellationToken): Promise<string> {
        const cacheKey = uri.toString();
        const cached = this._cache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }

        const filePath = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;

        // Special empty document for Add/Delete diffs
        if (filePath === '__empty__') {
            return '';
        }

        const params = new URLSearchParams(uri.query);
        const ref = params.get('ref') ?? 'HEAD';

        const repoRoot = this.gitApi?.repositories[0]?.rootUri.fsPath
            ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!repoRoot) {
            this.log.appendLine(`[git-content] No repo root or workspace root`);
            return '';
        }

        this.log.appendLine(`[git-content] Fetching ${ref}:${filePath}`);

        try {
            const content = await gitShow(repoRoot, ref, filePath);
            this._cache.set(cacheKey, content);
            return content;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.appendLine(`[git-content] Error: ${msg}`);
            // Return empty for files that don't exist at this ref (e.g. newly added files)
            this._cache.set(cacheKey, '');
            return '';
        }
    }

    /** Clear cache (e.g. after a fetch or branch switch). */
    clearCache(): void {
        this._cache.clear();
    }
}

/**
 * Build a URI for viewing a file at a specific git ref.
 */
export function buildGitRefUri(filePath: string, ref: string): vscode.Uri {
    return vscode.Uri.parse(`${GIT_CONTENT_SCHEME}:///${filePath}?ref=${encodeURIComponent(ref)}`);
}

/**
 * Run `git show ref:path` in the given repo directory.
 */
function gitShow(cwd: string, ref: string, filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            'git',
            ['show', `${ref}:${filePath}`],
            { cwd, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' },
            (err, stdout) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(stdout);
                }
            },
        );
    });
}
