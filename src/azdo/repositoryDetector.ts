import * as vscode from 'vscode';
import type { API, Repository } from '../typings/git';
import type { AzDoRemoteInfo } from './remoteInfo';
import { parseAzDoRemote } from './remoteParser';

/**
 * Watches the Git extension for repositories and detects the first Azure DevOps
 * remote. Fires an event when a repository is detected (or lost).
 */
export class RepositoryDetector implements vscode.Disposable {
    private readonly _disposables: vscode.Disposable[] = [];
    private _currentRemoteInfo: AzDoRemoteInfo | undefined;

    private readonly _onDidChange = new vscode.EventEmitter<AzDoRemoteInfo | undefined>();
    /** Fires when the detected AzDo remote info changes. */
    readonly onDidChange = this._onDidChange.event;

    get currentRemoteInfo(): AzDoRemoteInfo | undefined {
        return this._currentRemoteInfo;
    }

    /** The VS Code Git Repository that contains the detected AzDo remote. */
    get currentRepository(): import('../typings/git').Repository | undefined {
        return this._currentRemoteInfo?.repository;
    }

    constructor(private readonly gitApi: API, private readonly log: vscode.OutputChannel) {
        this.log.appendLine(`[detector] Initialising. Repositories known to git extension: ${gitApi.repositories.length}`);

        // Scan repositories already open
        this.scan('initial');

        // React to repos opening / closing
        this._disposables.push(
            gitApi.onDidOpenRepository(repo => {
                this.log.appendLine(`[detector] onDidOpenRepository: ${repo.rootUri.fsPath}`);
                this.scan('onDidOpenRepository');

                // Also listen for state changes within the repo (remotes may arrive late)
                this._disposables.push(
                    repo.state.onDidChange(() => {
                        this.log.appendLine(`[detector] repo state changed: ${repo.rootUri.fsPath} — remotes: ${repo.state.remotes.length}`);
                        this.scan('onDidChange (repo state)');
                    }),
                );
            }),
            gitApi.onDidCloseRepository(repo => {
                this.log.appendLine(`[detector] onDidCloseRepository: ${repo.rootUri.fsPath}`);
                this.scan('onDidCloseRepository');
            }),
        );

        // For repos that are already open, subscribe to their state changes too
        for (const repo of gitApi.repositories) {
            this._disposables.push(
                repo.state.onDidChange(() => {
                    this.log.appendLine(`[detector] repo state changed: ${repo.rootUri.fsPath} — remotes: ${repo.state.remotes.length}`);
                    this.scan('onDidChange (repo state)');
                }),
            );
        }
    }

    /** Scan all known repositories for the first AzDo remote. */
    private scan(trigger: string): void {
        this.log.appendLine(`[detector] scan triggered by: ${trigger}`);
        const info = this.findFirstAzDoRemote();
        const changed =
            info?.remoteUrl !== this._currentRemoteInfo?.remoteUrl;

        this._currentRemoteInfo = info;
        if (changed) {
            this.log.appendLine(`[detector] detection changed → ${info ? `${info.organization}/${info.project}/${info.repositoryName}` : '(none)'}`);
            this._onDidChange.fire(info);
        } else {
            this.log.appendLine(`[detector] no change from previous scan.`);
        }
    }

    private findFirstAzDoRemote(): AzDoRemoteInfo | undefined {
        this.log.appendLine(`[detector] scanning ${this.gitApi.repositories.length} repo(s)…`);
        for (const repo of this.gitApi.repositories) {
            this.log.appendLine(`[detector]   repo: ${repo.rootUri.fsPath}`);
            const info = this.detectInRepository(repo);
            if (info) {
                return info;
            }
        }
        return undefined;
    }

    private detectInRepository(repo: Repository): AzDoRemoteInfo | undefined {
        this.log.appendLine(`[detector]   remotes (${repo.state.remotes.length}):`);
        for (const remote of repo.state.remotes) {
            const url = remote.fetchUrl ?? remote.pushUrl;
            this.log.appendLine(`[detector]     ${remote.name}: fetchUrl=${remote.fetchUrl ?? '(none)'}, pushUrl=${remote.pushUrl ?? '(none)'}`);
            if (!url) {
                this.log.appendLine(`[detector]     → skipped (no URL)`);
                continue;
            }
            const parsed = parseAzDoRemote(url, remote.name);
            if (parsed) {
                this.log.appendLine(`[detector]     → MATCH: ${parsed.organization}/${parsed.project}/${parsed.repositoryName}`);
                return { ...parsed, repository: repo };
            } else {
                this.log.appendLine(`[detector]     → not an AzDO remote`);
            }
        }
        return undefined;
    }

    dispose(): void {
        this._onDidChange.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
    }
}
