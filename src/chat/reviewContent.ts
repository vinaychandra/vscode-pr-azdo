import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { lstat, readlink, realpath } from 'fs/promises';
import { isAbsolute, relative, sep } from 'path';
import { createTwoFilesPatch } from 'diff';
import { VersionControlChangeType, type GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { fileContentKey, type PullRequestService } from '../azdo/prService';
import { buildGitDiffArgs, type ReviewMode } from '../git/gitStateDetector';

export interface ReviewTarget {
    identity: string;
    repositoryRoot?: vscode.Uri;
    pr?: GitPullRequest;
    snapshot: boolean;
    checkoutBacked: boolean;
    sourceRef?: string;
    targetRef?: string;
    currentBranch?: string;
    iterationId?: number;
    compareToIterationId?: number;
    filePaths: readonly string[];
    changeTypes: ReadonlyMap<string, number>;
    originalPaths?: ReadonlyMap<string, string>;
    contents?: ReadonlyMap<string, string>;
    service?: Pick<PullRequestService, 'getFileContents' | 'listFiles'>;
}

export interface ReviewFile {
    path: string;
    basePath: string;
    base: string;
    source: string;
    baseExists: boolean;
    sourceExists: boolean;
    diff: string;
}

export function reviewPath(value: string): string {
    const path = value.replaceAll('\\', '/');
    if (!path || path.startsWith('/') || /^[a-z]:/i.test(path)
        || path.split('/').some(part => !part || part === '.' || part === '..')
        || /[\x00-\x1f]/.test(path)) {
        throw new Error('Expected a repository-relative file path without traversal.');
    }
    return path;
}

export function gitText(cwd: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', ['-c', 'core.quotePath=false', ...args], {
            cwd, encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024,
        }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`git ${args[0]} failed: ${stderr.trim() || error.message}`));
            } else {
                resolve(stdout);
            }
        });
    });
}

export async function repositoryFile(root: vscode.Uri, path: string): Promise<vscode.Uri> {
    const uri = vscode.Uri.joinPath(root, reviewPath(path));
    const [realRoot, realFile] = await Promise.all([realpath(root.fsPath), realpath(uri.fsPath)]);
    const withinRoot = relative(realRoot, realFile);
    if (withinRoot === '..' || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) {
        throw new Error('The requested checkout file resolves outside the reviewed repository.');
    }
    return uri;
}

export class ReviewContent {
    readonly files: ReviewFile[] = [];
    private readonly reads = new Map<string, string>();
    private baseRef: string | undefined;
    private sourceRef: string | undefined;
    private workingCopy = false;
    private index = false;

    constructor(readonly target: ReviewTarget, readonly mode: ReviewMode) { }

    async load(onlyPaths?: ReadonlySet<string>): Promise<void> {
        if (this.target.snapshot) {
            const { sourceRef, targetRef } = this.target;
            if (!sourceRef || !targetRef) {
                throw new Error('The PR comparison is incomplete. Refresh the pull request and try again.');
            }
            this.sourceRef = sourceRef;
            this.baseRef = targetRef;
            for (const path of this.target.filePaths) {
                if (onlyPaths && !onlyPaths.has(path)) { continue; }
                const change = this.target.changeTypes.get(path) ?? 0;
                await this.loadFile(
                    path, this.target.originalPaths?.get(path) ?? path,
                    !(change & VersionControlChangeType.Add),
                    !(change & VersionControlChangeType.Delete),
                );
            }
        } else {
            const root = this.target.repositoryRoot;
            if (!root) { throw new Error('A local repository is required to review local changes.'); }
            const cwd = root.fsPath;
            const targetRef = this.target.targetRef ?? 'origin/main';
            const currentRef = this.target.currentBranch ? `origin/${this.target.currentBranch}` : undefined;
            const args = buildGitDiffArgs(this.mode, targetRef, currentRef, []);
            const entries = (await gitText(cwd, [
                'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', ...args.slice(1),
            ])).split('\0');
            this.baseRef = this.mode === 'vs-target'
                ? (await gitText(cwd, ['merge-base', targetRef, 'HEAD'])).trim()
                : this.mode === 'unstaged' ? ':'
                    : this.mode === 'unpushed-commits' ? currentRef : 'HEAD';
            if (!this.baseRef) { throw new Error('The comparison branch could not be resolved.'); }
            this.index = this.mode === 'staged';
            this.workingCopy = this.mode !== 'staged' && this.mode !== 'unpushed-commits';
            this.sourceRef = this.index ? ':' : 'HEAD';
            for (let i = 0; i + 1 < entries.length; i += 2) {
                const [status, path] = [entries[i], entries[i + 1]];
                if (!status || !path) { continue; }
                if (onlyPaths && !onlyPaths.has(path)) { continue; }
                await this.loadFile(path, path, status !== 'A', status !== 'D');
            }
        }
    }

    private async loadFile(path: string, basePath: string, baseExists: boolean, sourceExists: boolean): Promise<void> {
        reviewPath(path);
        reviewPath(basePath);
        const base = baseExists ? await this.readAt(basePath, 'base') : '';
        const source = sourceExists ? await this.readAt(path, 'source') : '';
        this.files.push({
            path, basePath, base, source, baseExists, sourceExists,
            diff: base.includes('\0') || source.includes('\0')
                ? `Binary file changed: ${path}`
                : createTwoFilesPatch(
                    baseExists ? `a/${basePath}` : '/dev/null',
                    sourceExists ? `b/${path}` : '/dev/null',
                    base, source, this.baseRef, this.sourceRef,
                ),
        });
    }

    async read(path: string, side: 'base' | 'source' = 'source'): Promise<string> {
        path = reviewPath(path);
        const file = this.files.find(candidate => candidate.path === path);
        if (file) {
            if (!(side === 'base' ? file.baseExists : file.sourceExists)) {
                throw new Error(`${path} does not exist on the ${side} side of this comparison.`);
            }
            return side === 'base' ? file.base : file.source;
        }
        return this.readAt(path, side);
    }

    private async readAt(path: string, side: 'base' | 'source'): Promise<string> {
        const ref = side === 'base' ? this.baseRef : this.sourceRef;
        if (!ref) { throw new Error('The review content has not been loaded.'); }
        const key = `${side}:${path}`;
        const cached = this.reads.get(key);
        if (cached !== undefined) { return cached; }
        let content: string;
        const snapshotContent = this.target.contents?.get(fileContentKey(ref, path));
        if (snapshotContent !== undefined) {
            content = snapshotContent;
        } else if (this.target.snapshot && this.target.service) {
            const contents = await this.target.service.getFileContents([{ path, commitId: ref }], true);
            const fetched = contents.get(fileContentKey(ref, path));
            if (fetched === undefined) { throw new Error(`No content returned for ${path} at ${ref}.`); }
            content = fetched;
        } else {
            const root = this.target.repositoryRoot;
            if (!root) { throw new Error('The review repository is no longer available.'); }
            if (side === 'source' && this.workingCopy) {
                const uri = vscode.Uri.joinPath(root, path);
                content = (await lstat(uri.fsPath)).isSymbolicLink()
                    ? await readlink(uri.fsPath)
                    : Buffer.from(await vscode.workspace.fs.readFile(await repositoryFile(root, path))).toString('utf8');
            } else {
                content = await gitText(root.fsPath, ['show', `${ref === ':' ? '' : ref}:${path}`]);
            }
        }
        this.reads.set(key, content);
        return content;
    }

    async list(directory = ''): Promise<{ path: string; directory: boolean }[]> {
        if (directory) { directory = reviewPath(directory.replace(/\/$/, '')); }
        if (this.target.snapshot && this.target.service && this.sourceRef) {
            return this.target.service.listFiles(this.sourceRef, directory);
        }
        const root = this.target.repositoryRoot;
        if (!root) { throw new Error('The review repository is no longer available.'); }
        const files = (await gitText(root.fsPath, this.target.snapshot || (!this.workingCopy && !this.index)
            ? ['ls-tree', '-r', '--name-only', '-z', this.sourceRef!]
            : ['ls-files', '-z'])).split('\0').filter(Boolean);
        const prefix = directory ? `${directory}/` : '';
        const result = new Map<string, { path: string; directory: boolean }>();
        for (const path of files) {
            if (!path.startsWith(prefix)) { continue; }
            const child = path.slice(prefix.length).split('/')[0];
            const fullPath = `${prefix}${child}`;
            result.set(fullPath, { path: fullPath, directory: path !== fullPath });
        }
        return [...result.values()];
    }

    async assertUnchanged(paths: readonly string[]): Promise<void> {
        if (this.target.snapshot) { return; }
        const latest = new ReviewContent(this.target, this.mode);
        await latest.load(new Set(paths));
        for (const path of paths) {
            const captured = this.files.find(file => file.path === path);
            const current = latest.files.find(file => file.path === path);
            if (!captured || !current || captured.base !== current.base || captured.source !== current.source
                || captured.baseExists !== current.baseExists || captured.sourceExists !== current.sourceExists) {
                throw new Error(`${path} changed after this review started. Start a new review before creating drafts.`);
            }
        }
    }
}
