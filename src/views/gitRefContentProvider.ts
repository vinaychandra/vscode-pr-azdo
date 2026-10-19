import * as vscode from 'vscode';
import { execFile } from 'child_process';
import type { API } from '../typings/git';
import type { RepositoryDetector } from '../azdo/repositoryDetector';
import { getActiveRepository } from '../git/gitExtension';
import { fileContentKey } from '../azdo/prService';

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
export const AI_REVIEW_CONTENT_SCHEME = 'azdo-pr-ai-review';

/**
 * Provides readonly document content by running `git show {ref}:{path}`
 * against the local repository.
 */
export class GitRefContentProvider implements vscode.TextDocumentContentProvider {
    private _cache = new Map<string, string>();
    private _apiContents: ReadonlyMap<string, string> | undefined;
    private _draftContentReader: ((uri: vscode.Uri) => string | undefined) | undefined;

    constructor(
        private readonly log: vscode.OutputChannel,
        private readonly gitApi?: API,
        private readonly detector?: RepositoryDetector,
    ) { }

    async provideTextDocumentContent(uri: vscode.Uri, _token: vscode.CancellationToken): Promise<string> {
        const cacheKey = uri.toString();
        const cached = this._cache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }
        const draftContent = this._draftContentReader?.(uri);
        if (draftContent !== undefined) {
            this._cache.set(cacheKey, draftContent);
            return draftContent;
        }

        const filePath = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;

        // Special empty document for Add/Delete diffs
        if (filePath === '__empty__') {
            return '';
        }

        const params = new URLSearchParams(uri.query);
        const ref = params.get('ref') ?? 'HEAD';
        const apiContent = this._apiContents?.get(fileContentKey(ref, filePath));
        if (apiContent !== undefined) {
            this._cache.set(cacheKey, apiContent);
            return apiContent;
        }

        const repoRoot = (this.detector ? getActiveRepository(this.gitApi, this.detector) : this.gitApi?.repositories[0])?.rootUri.fsPath
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

    /** Set the immutable file contents for an API-backed review snapshot. */
    setApiContents(contents: ReadonlyMap<string, string> | undefined): void {
        this._apiContents = contents;
        this.clearCache();
    }

    setDraftContentReader(reader: (uri: vscode.Uri) => string | undefined): void {
        this._draftContentReader = reader;
    }
}

/**
 * Build a URI for viewing a file at a specific git ref.
 */
export function buildGitRefUri(filePath: string, ref: string): vscode.Uri {
    const path = filePath.split('/').map(encodeURIComponent).join('/');
    return vscode.Uri.parse(`${GIT_CONTENT_SCHEME}:///${path}?ref=${encodeURIComponent(ref)}`);
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
