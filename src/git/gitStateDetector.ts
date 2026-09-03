import * as vscode from 'vscode';
import { execFile } from 'child_process';
import type { Repository } from '../typings/git';

/** What kind of diff the user wants reviewed. */
export type ReviewMode =
    | 'staged'            // git diff --cached
    | 'unstaged'          // git diff  (working tree vs index)
    | 'all-uncommitted'   // git diff HEAD  (working tree vs last commit)
    | 'unpushed-commits'  // git diff origin/<current>..HEAD
    | 'vs-target';        // git diff --merge-base origin/<target> [-- files]

/** Snapshot of the git working tree / branch state. */
export interface GitWorkspaceState {
    hasStagedChanges: boolean;
    hasUnstagedChanges: boolean;
    hasUnpushedCommits: boolean;
    currentBranch: string | undefined;
    headSha: string | undefined;
    remoteBranchSha: string | undefined;
}

/**
 * Run `git rev-parse <ref>` and return the full SHA, or `undefined` if the ref
 * does not exist locally.
 */
function gitRevParse(cwd: string, ref: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        execFile(
            'git', ['rev-parse', ref],
            { cwd, encoding: 'utf-8' },
            (err, stdout) => {
                if (err) {
                    resolve(undefined);
                } else {
                    resolve(stdout.trim() || undefined);
                }
            },
        );
    });
}

/**
 * Detect the current git state of the workspace: dirty, pushed, etc.
 */
export async function detectGitState(
    repo: Repository,
    log: vscode.OutputChannel,
): Promise<GitWorkspaceState> {
    const cwd = repo.rootUri.fsPath;
    const currentBranch = repo.state.HEAD?.name;

    const hasStagedChanges = (repo.state.indexChanges?.length ?? 0) > 0;
    const hasUnstagedChanges = (repo.state.workingTreeChanges?.length ?? 0) > 0;

    // Resolve HEAD and its remote tracking branch
    const headSha = await gitRevParse(cwd, 'HEAD');
    let remoteBranchSha: string | undefined;
    if (currentBranch) {
        remoteBranchSha = await gitRevParse(cwd, `origin/${currentBranch}`);
    }

    const hasUnpushedCommits = !!(
        headSha && remoteBranchSha && headSha !== remoteBranchSha
    );

    log.appendLine(
        `[git-state] branch=${currentBranch ?? '(detached)'} ` +
        `staged=${hasStagedChanges} unstaged=${hasUnstagedChanges} ` +
        `HEAD=${headSha?.slice(0, 8) ?? 'n/a'} origin=${remoteBranchSha?.slice(0, 8) ?? 'n/a'} ` +
        `unpushed=${hasUnpushedCommits}`,
    );

    return {
        hasStagedChanges,
        hasUnstagedChanges,
        currentBranch,
        headSha,
        remoteBranchSha,
        hasUnpushedCommits,
    };
}

/** A QuickPick item that carries the chosen review mode. */
export interface ReviewQuickPickItem extends vscode.QuickPickItem {
    reviewMode: ReviewMode;
}

/**
 * Build the list of QuickPick items appropriate for the detected git state.
 * Returns `undefined` when no choice is needed (clean + pushed → auto-proceed).
 */
export function getReviewOptions(
    state: GitWorkspaceState,
    targetBranch: string,
    log: vscode.OutputChannel,
): ReviewQuickPickItem[] | undefined {
    const isDirty = state.hasStagedChanges || state.hasUnstagedChanges;
    const isClean = !isDirty;

    // Scenario 1: clean + pushed → no choice needed
    if (isClean && !state.hasUnpushedCommits) {
        log.appendLine('[git-state] Scenario 1: clean + pushed → auto-proceeding with vs-target');
        return undefined;
    }

    const items: ReviewQuickPickItem[] = [];

    // Scenario 2: clean + not pushed
    if (isClean && state.hasUnpushedCommits) {
        log.appendLine('[git-state] Scenario 2: clean + unpushed commits');
        items.push({
            label: '$(git-commit) Review unpushed commits only',
            description: `diff origin/${state.currentBranch}..HEAD`,
            detail: 'Compare your local commits against the last pushed state',
            reviewMode: 'unpushed-commits',
        });
        items.push({
            label: '$(git-compare) Review all changes vs remote target',
            description: `diff --merge-base origin/${targetBranch}`,
            detail: `Review changes introduced since the branch diverged from origin/${targetBranch}`,
            reviewMode: 'vs-target',
        });
        return items;
    }

    // Scenario 3: dirty working tree
    log.appendLine(
        `[git-state] Scenario 3: dirty tree (staged=${state.hasStagedChanges}, unstaged=${state.hasUnstagedChanges}, unpushed=${state.hasUnpushedCommits})`,
    );

    if (state.hasStagedChanges) {
        items.push({
            label: '$(diff-added) Review staged changes only',
            description: 'git diff --cached',
            detail: 'Review only the changes you have staged (index vs last commit)',
            reviewMode: 'staged',
        });
    }

    if (state.hasUnstagedChanges) {
        items.push({
            label: '$(diff-modified) Review unstaged changes only',
            description: 'git diff',
            detail: 'Review only the changes not yet staged (working tree vs index)',
            reviewMode: 'unstaged',
        });
    }

    items.push({
        label: '$(diff) Review all uncommitted changes vs last commit',
        description: 'git diff HEAD',
        detail: 'Review both staged and unstaged changes against your last commit',
        reviewMode: 'all-uncommitted',
    });

    if (state.hasUnpushedCommits) {
        items.push({
            label: '$(git-commit) Review committed but non-pushed changes',
            description: `diff origin/${state.currentBranch}..HEAD`,
            detail: 'Review only committed changes that have not been pushed yet',
            reviewMode: 'unpushed-commits',
        });
    }

    items.push({
        label: '$(git-compare) Review everything vs remote target',
        description: `diff --merge-base origin/${targetBranch}`,
        detail: `Review committed and working-tree changes introduced since the branch diverged from origin/${targetBranch}`,
        reviewMode: 'vs-target',
    });

    return items;
}

/**
 * Build the `git diff` argument list for the chosen review mode.
 */
export function buildGitDiffArgs(
    mode: ReviewMode,
    targetRef: string,
    currentBranchRef: string | undefined,
    filePaths: string[],
): string[] {
    switch (mode) {
        case 'staged':
            return ['diff', '--cached'];
        case 'unstaged':
            return ['diff'];
        case 'all-uncommitted':
            return ['diff', 'HEAD'];
        case 'unpushed-commits':
            return ['diff', `${currentBranchRef ?? 'origin/HEAD'}..HEAD`];
        case 'vs-target':
            return filePaths.length > 0
                ? ['diff', '--merge-base', targetRef, '--', ...filePaths]
                : ['diff', '--merge-base', targetRef];
    }
}

/** Human-readable label for what's being reviewed, used in progress messages. */
export function reviewModeLabel(mode: ReviewMode, targetBranch?: string): string {
    switch (mode) {
        case 'staged':
            return 'staged changes';
        case 'unstaged':
            return 'unstaged changes';
        case 'all-uncommitted':
            return 'all uncommitted changes vs last commit';
        case 'unpushed-commits':
            return 'unpushed commits';
        case 'vs-target':
            return targetBranch ? `changes vs ${targetBranch}` : 'changes vs target branch';
    }
}
