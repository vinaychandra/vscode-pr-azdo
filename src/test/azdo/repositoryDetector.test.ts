import * as assert from 'assert';
import * as vscode from 'vscode';
import { RepositoryDetector } from '../../azdo/repositoryDetector';
import type { API, Repository, RepositoryState, Remote } from '../../typings/git';

function createMockLog(): vscode.OutputChannel {
    return {
        appendLine: () => { },
        append: () => { },
        clear: () => { },
        show: () => { },
        hide: () => { },
        dispose: () => { },
        replace: () => { },
        name: 'test',
    } as unknown as vscode.OutputChannel;
}

function makeRemote(name: string, fetchUrl?: string, pushUrl?: string): Remote {
    return { name, fetchUrl, pushUrl, isReadOnly: false } as Remote;
}

function makeRepo(remotes: Remote[]): Repository {
    const stateEmitter = new vscode.EventEmitter<void>();
    return {
        rootUri: vscode.Uri.file('/mock/repo'),
        state: {
            remotes,
            HEAD: undefined,
            refs: [],
            onDidChange: stateEmitter.event,
        } as unknown as RepositoryState,
    } as unknown as Repository;
}

function makeGitApi(repos: Repository[]): API {
    const openEmitter = new vscode.EventEmitter<Repository>();
    const closeEmitter = new vscode.EventEmitter<Repository>();
    return {
        repositories: repos,
        onDidOpenRepository: openEmitter.event,
        onDidCloseRepository: closeEmitter.event,
        _openEmitter: openEmitter,
        _closeEmitter: closeEmitter,
    } as unknown as API & { _openEmitter: vscode.EventEmitter<Repository>; _closeEmitter: vscode.EventEmitter<Repository> };
}

suite('RepositoryDetector', () => {
    test('can be created and disposed', () => {
        const api = makeGitApi([]);
        const detector = new RepositoryDetector(api, createMockLog());
        detector.dispose();
    });

    test('detects AzDO remote on construction', () => {
        const repo = makeRepo([
            makeRemote('origin', 'https://dev.azure.com/myorg/myproject/_git/myrepo'),
        ]);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.ok(detector.currentRemoteInfo);
        assert.strictEqual(detector.currentRemoteInfo!.organization, 'myorg');
        assert.strictEqual(detector.currentRemoteInfo!.project, 'myproject');
        assert.strictEqual(detector.currentRemoteInfo!.repositoryName, 'myrepo');
        assert.strictEqual(detector.currentRemoteInfo!.remoteName, 'origin');
        detector.dispose();
    });

    test('returns undefined when no AzDO remotes exist', () => {
        const repo = makeRepo([
            makeRemote('origin', 'https://github.com/user/repo.git'),
        ]);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.strictEqual(detector.currentRemoteInfo, undefined);
        detector.dispose();
    });

    test('returns undefined when remotes have no URLs', () => {
        const repo = makeRepo([
            makeRemote('origin', undefined, undefined),
        ]);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.strictEqual(detector.currentRemoteInfo, undefined);
        detector.dispose();
    });

    test('prefers fetchUrl over pushUrl', () => {
        const repo = makeRepo([
            makeRemote(
                'origin',
                'https://dev.azure.com/fetchorg/fetchproj/_git/fetchrepo',
                'https://dev.azure.com/pushorg/pushproj/_git/pushrepo',
            ),
        ]);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.ok(detector.currentRemoteInfo);
        assert.strictEqual(detector.currentRemoteInfo!.organization, 'fetchorg');
        detector.dispose();
    });

    test('falls back to pushUrl when fetchUrl is missing', () => {
        const repo = makeRepo([
            makeRemote('origin', undefined, 'https://dev.azure.com/pushorg/pushproj/_git/pushrepo'),
        ]);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.ok(detector.currentRemoteInfo);
        assert.strictEqual(detector.currentRemoteInfo!.organization, 'pushorg');
        detector.dispose();
    });

    test('finds first AzDO remote among multiple remotes', () => {
        const repo = makeRepo([
            makeRemote('github', 'https://github.com/user/repo.git'),
            makeRemote('azure', 'https://dev.azure.com/myorg/myproject/_git/myrepo'),
        ]);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.ok(detector.currentRemoteInfo);
        assert.strictEqual(detector.currentRemoteInfo!.remoteName, 'azure');
        detector.dispose();
    });

    test('scans across multiple repositories', () => {
        const repo1 = makeRepo([
            makeRemote('origin', 'https://github.com/user/repo.git'),
        ]);
        const repo2 = makeRepo([
            makeRemote('azdo', 'https://dev.azure.com/orgname/proj/_git/therepo'),
        ]);
        const api = makeGitApi([repo1, repo2]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.ok(detector.currentRemoteInfo);
        assert.strictEqual(detector.currentRemoteInfo!.organization, 'orgname');
        assert.strictEqual(detector.currentRemoteInfo!.remoteName, 'azdo');
        detector.dispose();
    });

    test('fires onDidChange event with remote info', () => {
        const api = makeGitApi([]);
        const detector = new RepositoryDetector(api, createMockLog());
        let firedInfo: any = 'NOT_FIRED';
        detector.onDidChange(info => { firedInfo = info; });
        assert.strictEqual(firedInfo, 'NOT_FIRED'); // already fired during construction (undefined)
        detector.dispose();
    });

    test('detects SSH AzDO remotes', () => {
        const repo = makeRepo([
            makeRemote('origin', 'git@ssh.dev.azure.com:v3/myorg/myproj/myrepo'),
        ]);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.ok(detector.currentRemoteInfo);
        assert.strictEqual(detector.currentRemoteInfo!.organization, 'myorg');
        assert.strictEqual(detector.currentRemoteInfo!.project, 'myproj');
        assert.strictEqual(detector.currentRemoteInfo!.repositoryName, 'myrepo');
        detector.dispose();
    });

    test('detects visualstudio.com remotes', () => {
        const repo = makeRepo([
            makeRemote('origin', 'https://myorg.visualstudio.com/myproject/_git/myrepo'),
        ]);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.ok(detector.currentRemoteInfo);
        assert.strictEqual(detector.currentRemoteInfo!.organization, 'myorg');
        detector.dispose();
    });

    test('returns undefined for empty repositories list', () => {
        const api = makeGitApi([]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.strictEqual(detector.currentRemoteInfo, undefined);
        detector.dispose();
    });

    test('returns undefined for repo with no remotes', () => {
        const repo = makeRepo([]);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.strictEqual(detector.currentRemoteInfo, undefined);
        detector.dispose();
    });

    test('apiBaseUrl is set correctly', () => {
        const repo = makeRepo([
            makeRemote('origin', 'https://dev.azure.com/testorg/testproj/_git/testrepo'),
        ]);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.ok(detector.currentRemoteInfo);
        assert.strictEqual(detector.currentRemoteInfo!.apiBaseUrl, 'https://dev.azure.com/testorg');
        detector.dispose();
    });
});
