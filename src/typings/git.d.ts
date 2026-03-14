/*---------------------------------------------------------------------------------------------
 *  Minimal type definitions for VS Code's built-in Git extension API (version 1).
 *  Sourced from vscode.git's exported API surface.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, Event, Uri } from 'vscode';

export interface GitExtension {
    readonly enabled: boolean;
    readonly onDidChangeEnablement: Event<boolean>;
    getAPI(version: 1): API;
}

export interface API {
    readonly repositories: Repository[];
    readonly onDidOpenRepository: Event<Repository>;
    readonly onDidCloseRepository: Event<Repository>;
}

export interface Repository {
    readonly rootUri: Uri;
    readonly state: RepositoryState;
}

export interface RepositoryState {
    readonly HEAD: Branch | undefined;
    readonly remotes: readonly Remote[];
    readonly onDidChange: Event<void>;
}

export interface Branch {
    readonly name: string | undefined;
    readonly upstream?: { name: string; remote: string };
}

export interface Remote {
    readonly name: string;
    readonly fetchUrl: string | undefined;
    readonly pushUrl: string | undefined;
}
