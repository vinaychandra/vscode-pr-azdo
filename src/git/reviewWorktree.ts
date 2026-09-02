import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

export const DEFAULT_REVIEW_WORKTREE_PATH = '../${repo}.worktrees/review';

export class DirtyReviewWorktreeError extends Error {
    constructor(public readonly worktreePath: string) {
        super(`Review worktree has uncommitted changes: ${worktreePath}`);
        this.name = 'DirtyReviewWorktreeError';
    }
}

export interface PreparedReviewWorktree {
    path: string;
    commitId: string;
    reused: boolean;
}

function git(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(stderr.trim() || err.message));
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

function normalizedPath(value: string): string {
    const normalized = path.resolve(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function areSamePaths(first: string, second: string): boolean {
    return normalizedPath(first) === normalizedPath(second);
}

export function resolveReviewWorktreePath(primaryRoot: string, configuredPath = DEFAULT_REVIEW_WORKTREE_PATH): string {
    const repoName = path.basename(primaryRoot);
    const expanded = (configuredPath.trim() || DEFAULT_REVIEW_WORKTREE_PATH).replaceAll('${repo}', repoName);
    return path.resolve(primaryRoot, expanded);
}

export function parseWorktreePaths(porcelainOutput: string): string[] {
    return porcelainOutput
        .split(/\r?\n/)
        .filter(line => line.startsWith('worktree '))
        .map(line => line.substring('worktree '.length).trim())
        .filter(Boolean);
}

/** Resolve the primary worktree even when called from a linked worktree. */
export async function getPrimaryWorktreeRoot(repoRoot: string): Promise<string> {
    const commonGitDir = await git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return path.normalize(path.dirname(commonGitDir));
}

/** Fetch a PR source ref without creating a local branch and return its commit ID. */
export async function fetchPullRequestCommit(repoRoot: string, remoteName: string, sourceRefName: string): Promise<string> {
    try {
        await git(repoRoot, ['fetch', '--no-tags', remoteName, sourceRefName]);
        return await git(repoRoot, ['rev-parse', 'FETCH_HEAD^{commit}']);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Unable to fetch PR source ref ${sourceRefName} from ${remoteName}: ${msg}`);
    }
}

async function hasInProgressGitOperation(worktreePath: string): Promise<boolean> {
    const markers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply'];
    for (const marker of markers) {
        const markerPath = await git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-path', marker]);
        try {
            await fs.access(markerPath);
            return true;
        } catch { /* marker absent */ }
    }
    return false;
}

/** Create or update the single detached review worktree. */
export async function prepareReviewWorktree(
    repoRoot: string,
    worktreePath: string,
    commitId: string,
): Promise<PreparedReviewWorktree> {
    const primaryRoot = await getPrimaryWorktreeRoot(repoRoot);
    if (areSamePaths(worktreePath, primaryRoot)) {
        throw new Error('Review worktree path cannot be the primary repository root.');
    }

    await git(repoRoot, ['worktree', 'prune']);
    const registeredPaths = parseWorktreePaths(await git(repoRoot, ['worktree', 'list', '--porcelain']));
    const registered = registeredPaths.some(existing => areSamePaths(existing, worktreePath));

    if (registered) {
        const status = await git(worktreePath, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none']);
        if (status || await hasInProgressGitOperation(worktreePath)) {
            throw new DirtyReviewWorktreeError(worktreePath);
        }
        await git(worktreePath, ['checkout', '--detach', commitId]);
        return { path: worktreePath, commitId, reused: true };
    }

    try {
        const entries = await fs.readdir(worktreePath);
        if (entries.length > 0) {
            throw new Error(`Review worktree path exists and is not empty: ${worktreePath}`);
        }
        await fs.rmdir(worktreePath);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err;
        }
    }

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await git(repoRoot, ['worktree', 'add', '--detach', worktreePath, commitId]);
    return { path: worktreePath, commitId, reused: false };
}