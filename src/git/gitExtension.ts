import * as vscode from 'vscode';
import { execFile } from 'child_process';
import type { API, GitExtension } from '../typings/git';

/**
 * Acquire the VS Code built-in Git extension API.
 * Returns `undefined` if the git extension is not available.
 */
export async function getGitAPI(log: vscode.OutputChannel): Promise<API | undefined> {
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExtension) {
        log.appendLine('[git] vscode.git extension not found among installed extensions.');
        vscode.window.showWarningMessage(
            'Azure DevOps PR: The Git extension is required but not available.'
        );
        return undefined;
    }

    log.appendLine(`[git] vscode.git extension found. Active: ${gitExtension.isActive}`);

    if (!gitExtension.isActive) {
        log.appendLine('[git] Activating vscode.git extension…');
        await gitExtension.activate();
        log.appendLine('[git] vscode.git extension activated.');
    }

    const git = gitExtension.exports;
    if (!git.enabled) {
        log.appendLine('[git] Git extension is disabled.');
        vscode.window.showWarningMessage(
            'Azure DevOps PR: The Git extension is disabled. Please enable it.'
        );
        return undefined;
    }

    const api = git.getAPI(1);
    log.appendLine(`[git] Git API acquired. Initial repository count: ${api.repositories.length}`);
    return api;
}

/**
 * Delete a local git branch.
 * Uses `git branch -d` (safe) or `git branch -D` (force) via child_process
 * since the VS Code Git extension API does not expose branch deletion.
 */
export function deleteLocalBranch(repoRoot: string, branchName: string, force = false): Promise<void> {
    return new Promise((resolve, reject) => {
        const flag = force ? '-D' : '-d';
        execFile('git', ['branch', flag, branchName], { cwd: repoRoot }, (err, _stdout, stderr) => {
            if (err) {
                reject(new Error(stderr.trim() || err.message));
            } else {
                resolve();
            }
        });
    });
}
