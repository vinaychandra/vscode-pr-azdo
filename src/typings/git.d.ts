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
    checkout(treeish: string): Promise<void>;
    fetch(remote?: string, ref?: string): Promise<void>;
    push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
    add(resources: Uri[]): Promise<void>;
    commit(message: string): Promise<void>;
}

export interface Change {
    readonly uri: Uri;
    readonly originalUri: Uri;
    readonly renameUri: Uri | undefined;
    readonly status: number;
}

export interface RepositoryState {
    readonly HEAD: Branch | undefined;
    readonly remotes: readonly Remote[];
    readonly indexChanges: readonly Change[];
    readonly workingTreeChanges: readonly Change[];
    readonly mergeChanges: readonly Change[];
    readonly onDidChange: Event<void>;
}

export interface Branch {
    readonly name: string | undefined;
    readonly commit?: string;
    readonly upstream?: { name: string; remote: string };
}

export interface Remote {
    readonly name: string;
    readonly fetchUrl: string | undefined;
    readonly pushUrl: string | undefined;
}
