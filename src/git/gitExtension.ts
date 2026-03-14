import * as vscode from 'vscode';
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
