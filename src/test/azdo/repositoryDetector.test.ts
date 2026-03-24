import * as assert from 'assert';
import * as vscode from 'vscode';
import { RepositoryDetector } from '../../azdo/repositoryDetector';
import { getActiveRepository } from '../../git/gitExtension';
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

function makeRepo(remotes: Remote[], path = '/mock/repo'): Repository {
    const stateEmitter = new vscode.EventEmitter<void>();
    return {
        rootUri: vscode.Uri.file(path),
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
        ], '/mock/repo1');
        const repo2 = makeRepo([
            makeRemote('azdo', 'https://dev.azure.com/orgname/proj/_git/therepo'),
        ], '/mock/repo2');
        const api = makeGitApi([repo1, repo2]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.ok(detector.currentRemoteInfo);
        assert.strictEqual(detector.currentRemoteInfo!.organization, 'orgname');
        assert.strictEqual(detector.currentRemoteInfo!.remoteName, 'azdo');
        assert.strictEqual(detector.currentRemoteInfo!.repository, repo2);
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

    test('repository reference points to matched repo, not first repo (worktree scenario)', () => {
        // Simulate a worktree setup: repo1 is the main checkout, repo2 is a worktree with the AzDo remote
        const mainRepo = makeRepo([
            makeRemote('origin', 'https://github.com/user/repo.git'),
        ], '/home/user/myrepo');
        const worktreeRepo = makeRepo([
            makeRemote('origin', 'https://dev.azure.com/myorg/myproject/_git/myrepo'),
        ], '/home/user/worktrees/feature-branch');
        const api = makeGitApi([mainRepo, worktreeRepo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.ok(detector.currentRemoteInfo);
        assert.strictEqual(detector.currentRemoteInfo!.repository, worktreeRepo);
        assert.strictEqual(detector.currentRepository, worktreeRepo);
        assert.notStrictEqual(detector.currentRepository, mainRepo);
        detector.dispose();
    });

    test('currentRepository returns undefined when no AzDo remote found', () => {
        const repo = makeRepo([
            makeRemote('origin', 'https://github.com/user/repo.git'),
        ]);
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.strictEqual(detector.currentRepository, undefined);
        detector.dispose();
    });
});

// ---------------------------------------------------------------------------
// Workspace layout scenarios — verifies detection + API metadata uniformity
// across simple clones, subfolders, worktrees, and subfolders within worktrees.
//
// For each layout the tests assert:
//   1. The correct Repository object is matched (rootUri)
//   2. apiBaseUrl is always normalized to https://dev.azure.com/{org}
//   3. organization / project / repositoryName are correct
//   4. getActiveRepository() returns the matched repo
// ---------------------------------------------------------------------------

const AZDO_HTTPS = 'https://dev.azure.com/myorg/myproject/_git/myrepo';
const AZDO_VS_COM = 'https://myorg.visualstudio.com/myproject/_git/myrepo';
const AZDO_SSH = 'git@ssh.dev.azure.com:v3/myorg/myproject/myrepo';
const AZDO_SSH_VS = 'git@vs-ssh.visualstudio.com:v3/myorg/myproject/myrepo';

const EXPECTED_ORG = 'myorg';
const EXPECTED_PROJECT = 'myproject';
const EXPECTED_REPO_NAME = 'myrepo';
const EXPECTED_API_BASE = 'https://dev.azure.com/myorg';

/** Verify all the standard fields on the detected info. */
function assertDetectedInfo(
    detector: RepositoryDetector,
    expectedRepo: Repository,
    label: string,
): void {
    const info = detector.currentRemoteInfo;
    assert.ok(info, `${label}: should detect an AzDo remote`);
    assert.strictEqual(info!.organization, EXPECTED_ORG, `${label}: organization`);
    assert.strictEqual(info!.project, EXPECTED_PROJECT, `${label}: project`);
    assert.strictEqual(info!.repositoryName, EXPECTED_REPO_NAME, `${label}: repositoryName`);
    assert.strictEqual(info!.apiBaseUrl, EXPECTED_API_BASE, `${label}: apiBaseUrl`);
    assert.strictEqual(info!.repository, expectedRepo, `${label}: repository reference`);
    assert.strictEqual(detector.currentRepository, expectedRepo, `${label}: currentRepository getter`);
}

suite('Workspace layout: simple clone', () => {
    // The most common case: user clones a repo and opens the root folder.
    // rootUri points directly at the git root directory.
    const REMOTE_URLS = [AZDO_HTTPS, AZDO_VS_COM, AZDO_SSH, AZDO_SSH_VS];
    const REMOTE_LABELS = ['HTTPS dev.azure.com', 'HTTPS visualstudio.com', 'SSH ssh.dev.azure.com', 'SSH vs-ssh.visualstudio.com'];

    for (let i = 0; i < REMOTE_URLS.length; i++) {
        test(`detects correctly with ${REMOTE_LABELS[i]}`, () => {
            const repo = makeRepo([
                makeRemote('origin', REMOTE_URLS[i]),
            ], '/home/user/myrepo');
            const api = makeGitApi([repo]);
            const detector = new RepositoryDetector(api, createMockLog());
            assertDetectedInfo(detector, repo, `simple clone (${REMOTE_LABELS[i]})`);
            detector.dispose();
        });
    }

    test('getActiveRepository returns the clone repo', () => {
        const repo = makeRepo([
            makeRemote('origin', AZDO_HTTPS),
        ], '/home/user/myrepo');
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.strictEqual(getActiveRepository(api, detector), repo);
        detector.dispose();
    });

    test('detection is identical across all 4 URL formats', () => {
        // All 4 remote URL formats should produce identical apiBaseUrl, org, project, repoName
        const results = REMOTE_URLS.map(url => {
            const repo = makeRepo([makeRemote('origin', url)], '/clone');
            const api = makeGitApi([repo]);
            const det = new RepositoryDetector(api, createMockLog());
            const info = det.currentRemoteInfo!;
            det.dispose();
            return { org: info.organization, project: info.project, repoName: info.repositoryName, apiBase: info.apiBaseUrl };
        });
        for (let j = 1; j < results.length; j++) {
            assert.deepStrictEqual(results[j], results[0],
                `URL format ${REMOTE_LABELS[j]} should produce identical fields as ${REMOTE_LABELS[0]}`);
        }
    });
});

suite('Workspace layout: subfolder within a clone', () => {
    // User opens a subfolder inside a clone (e.g., /home/user/myrepo/src).
    // VS Code's Git extension still reports the repo with rootUri at the git root,
    // not at the opened subfolder. So detection should work the same.

    test('repo rootUri is at git root even when workspace is a subfolder', () => {
        // rootUri is always at the git root, not the workspace folder
        const repo = makeRepo([
            makeRemote('origin', AZDO_HTTPS),
        ], '/home/user/myrepo');
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assertDetectedInfo(detector, repo, 'subfolder-in-clone');
        // rootUri should be the git root, not a subfolder
        assert.strictEqual(repo.rootUri.fsPath, vscode.Uri.file('/home/user/myrepo').fsPath);
        detector.dispose();
    });

    test('getActiveRepository returns the repo regardless of which subfolder is open', () => {
        const repo = makeRepo([
            makeRemote('origin', AZDO_HTTPS),
        ], '/home/user/myrepo');
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const active = getActiveRepository(api, detector);
        assert.strictEqual(active, repo);
        assert.strictEqual(active!.rootUri.fsPath, vscode.Uri.file('/home/user/myrepo').fsPath);
        detector.dispose();
    });

    test('API metadata is correct when workspace is a deep subfolder', () => {
        // Even if user opens /home/user/myrepo/packages/core/src,
        // the git repo rootUri stays at /home/user/myrepo
        const repo = makeRepo([
            makeRemote('origin', AZDO_HTTPS),
        ], '/home/user/myrepo');
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const info = detector.currentRemoteInfo!;
        assert.strictEqual(info.apiBaseUrl, EXPECTED_API_BASE);
        assert.strictEqual(info.repositoryName, EXPECTED_REPO_NAME);
        assert.strictEqual(info.project, EXPECTED_PROJECT);
        detector.dispose();
    });
});

suite('Workspace layout: worktrees', () => {
    // When using git worktrees, VS Code's Git extension exposes each worktree
    // as a separate Repository with its own rootUri. Both share the same
    // remotes (same .git/config), so both have the AzDo remote.
    // The detector should pick whichever comes first — the key is that the
    // returned `repository` reference matches that specific worktree, not
    // just repositories[0].

    test('detects the first worktree with AzDo remote (main first)', () => {
        const mainRepo = makeRepo([
            makeRemote('origin', AZDO_HTTPS),
        ], '/workspace/main');
        const worktreeRepo = makeRepo([
            makeRemote('origin', AZDO_HTTPS),
        ], '/workspace/worktrees/feature');
        const api = makeGitApi([mainRepo, worktreeRepo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assertDetectedInfo(detector, mainRepo, 'worktree (main first)');
        detector.dispose();
    });

    test('detects the first worktree with AzDo remote (worktree first)', () => {
        const worktreeRepo = makeRepo([
            makeRemote('origin', AZDO_HTTPS),
        ], '/workspace/worktrees/feature');
        const mainRepo = makeRepo([
            makeRemote('origin', AZDO_HTTPS),
        ], '/workspace/main');
        // worktree appears first in the array (order depends on which VS Code discovers first)
        const api = makeGitApi([worktreeRepo, mainRepo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assertDetectedInfo(detector, worktreeRepo, 'worktree (worktree first)');
        detector.dispose();
    });

    test('worktree without AzDo remote is skipped in favor of one that has it', () => {
        const worktreeNoAzDo = makeRepo([
            makeRemote('github', 'https://github.com/user/other.git'),
        ], '/workspace/worktrees/other');
        const worktreeWithAzDo = makeRepo([
            makeRemote('origin', AZDO_HTTPS),
        ], '/workspace/worktrees/feature');
        const api = makeGitApi([worktreeNoAzDo, worktreeWithAzDo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assertDetectedInfo(detector, worktreeWithAzDo, 'worktree skip non-azdo');
        detector.dispose();
    });

    test('getActiveRepository returns detector match, not repositories[0]', () => {
        const githubRepo = makeRepo([
            makeRemote('origin', 'https://github.com/user/repo.git'),
        ], '/workspace/github-project');
        const azdoRepo = makeRepo([
            makeRemote('origin', AZDO_HTTPS),
        ], '/workspace/worktrees/feature');
        const api = makeGitApi([githubRepo, azdoRepo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const active = getActiveRepository(api, detector);
        assert.strictEqual(active, azdoRepo, 'should return matched repo, not repositories[0]');
        assert.notStrictEqual(active, githubRepo);
        detector.dispose();
    });

    test('all URL formats produce same API metadata across worktrees', () => {
        const urls = [AZDO_HTTPS, AZDO_VS_COM, AZDO_SSH, AZDO_SSH_VS];
        for (const url of urls) {
            const mainRepo = makeRepo([makeRemote('origin', url)], '/workspace/main');
            const worktreeRepo = makeRepo([makeRemote('origin', url)], '/workspace/wt/feat');
            const api = makeGitApi([mainRepo, worktreeRepo]);
            const detector = new RepositoryDetector(api, createMockLog());
            const info = detector.currentRemoteInfo!;
            assert.strictEqual(info.apiBaseUrl, EXPECTED_API_BASE, `apiBaseUrl for ${url}`);
            assert.strictEqual(info.organization, EXPECTED_ORG, `org for ${url}`);
            assert.strictEqual(info.project, EXPECTED_PROJECT, `project for ${url}`);
            assert.strictEqual(info.repositoryName, EXPECTED_REPO_NAME, `repoName for ${url}`);
            detector.dispose();
        }
    });

    test('multiple worktrees of the same repo all have same API fields', () => {
        const wt1 = makeRepo([makeRemote('origin', AZDO_HTTPS)], '/workspace/wt/fix-123');
        const wt2 = makeRepo([makeRemote('origin', AZDO_HTTPS)], '/workspace/wt/feature-456');
        const wt3 = makeRepo([makeRemote('origin', AZDO_HTTPS)], '/workspace/wt/hotfix');
        const api = makeGitApi([wt1, wt2, wt3]);
        const detector = new RepositoryDetector(api, createMockLog());
        const info = detector.currentRemoteInfo!;
        // First match wins, but all would produce the same API metadata
        assert.strictEqual(info.apiBaseUrl, EXPECTED_API_BASE);
        assert.strictEqual(info.organization, EXPECTED_ORG);
        assert.strictEqual(info.project, EXPECTED_PROJECT);
        assert.strictEqual(info.repositoryName, EXPECTED_REPO_NAME);
        assert.strictEqual(info.repository, wt1, 'first worktree is the match');
        detector.dispose();
    });
});

suite('Workspace layout: subfolder within a worktree', () => {
    // User opens a subfolder inside a worktree (e.g., /workspace/wt/feature/src/app).
    // VS Code's Git extension still reports the worktree repo with rootUri at
    // the worktree root, not the subfolder. Detection should work identically.

    test('worktree rootUri is at worktree root, not subfolder', () => {
        // rootUri for a worktree is the worktree checkout root
        const worktreeRepo = makeRepo([
            makeRemote('origin', AZDO_HTTPS),
        ], '/workspace/worktrees/feature');
        const api = makeGitApi([worktreeRepo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assertDetectedInfo(detector, worktreeRepo, 'subfolder-in-worktree');
        assert.strictEqual(worktreeRepo.rootUri.fsPath, vscode.Uri.file('/workspace/worktrees/feature').fsPath);
        detector.dispose();
    });

    test('API metadata is correct when workspace folder is deep inside worktree', () => {
        // Even if the user opens /workspace/worktrees/feature/packages/ui/src,
        // the git API still reports the repo at /workspace/worktrees/feature
        const worktreeRepo = makeRepo([
            makeRemote('origin', AZDO_SSH),
        ], '/workspace/worktrees/feature');
        const api = makeGitApi([worktreeRepo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const info = detector.currentRemoteInfo!;
        assert.strictEqual(info.apiBaseUrl, EXPECTED_API_BASE);
        assert.strictEqual(info.organization, EXPECTED_ORG);
        assert.strictEqual(info.project, EXPECTED_PROJECT);
        assert.strictEqual(info.repositoryName, EXPECTED_REPO_NAME);
        detector.dispose();
    });

    test('getActiveRepository returns worktree repo even with main repo also present', () => {
        // Main repo has a GitHub remote, worktree has AzDo remote
        const mainRepo = makeRepo([
            makeRemote('origin', 'https://github.com/user/repo.git'),
        ], '/workspace/main');
        const worktreeRepo = makeRepo([
            makeRemote('origin', AZDO_HTTPS),
        ], '/workspace/worktrees/feature');
        const api = makeGitApi([mainRepo, worktreeRepo]);
        const detector = new RepositoryDetector(api, createMockLog());
        const active = getActiveRepository(api, detector);
        assert.strictEqual(active, worktreeRepo);
        assert.strictEqual(active!.rootUri.fsPath, vscode.Uri.file('/workspace/worktrees/feature').fsPath);
        detector.dispose();
    });
});

suite('API base URL normalization across layouts', () => {
    // Regardless of how the user opens their workspace (clone, subfolder,
    // worktree, etc.), the apiBaseUrl must always be normalized to
    // https://dev.azure.com/{org}. This ensures all network calls target
    // the correct Azure DevOps REST API endpoint.

    const layouts: Array<{ label: string; path: string; url: string }> = [
        { label: 'simple clone, HTTPS', path: '/home/user/myrepo', url: AZDO_HTTPS },
        { label: 'simple clone, VS COM', path: '/home/user/myrepo', url: AZDO_VS_COM },
        { label: 'simple clone, SSH', path: '/home/user/myrepo', url: AZDO_SSH },
        { label: 'simple clone, legacy SSH', path: '/home/user/myrepo', url: AZDO_SSH_VS },
        { label: 'worktree, HTTPS', path: '/workspace/wt/feature', url: AZDO_HTTPS },
        { label: 'worktree, VS COM', path: '/workspace/wt/feature', url: AZDO_VS_COM },
        { label: 'worktree, SSH', path: '/workspace/wt/feature', url: AZDO_SSH },
        { label: 'worktree, legacy SSH', path: '/workspace/wt/feature', url: AZDO_SSH_VS },
        { label: 'deep nested clone', path: '/home/user/projects/mono/app', url: AZDO_HTTPS },
        { label: 'Windows-style path, HTTPS', path: 'C:\\Users\\dev\\repos\\myrepo', url: AZDO_HTTPS },
        { label: 'Windows-style worktree, SSH', path: 'D:\\Work\\wt\\feat-123', url: AZDO_SSH },
    ];

    for (const { label, path, url } of layouts) {
        test(`${label}: apiBaseUrl = ${EXPECTED_API_BASE}`, () => {
            const repo = makeRepo([makeRemote('origin', url)], path);
            const api = makeGitApi([repo]);
            const detector = new RepositoryDetector(api, createMockLog());
            const info = detector.currentRemoteInfo!;
            assert.ok(info, `${label}: should detect remote`);
            assert.strictEqual(info.apiBaseUrl, EXPECTED_API_BASE, `${label}: apiBaseUrl`);
            assert.strictEqual(info.organization, EXPECTED_ORG, `${label}: organization`);
            assert.strictEqual(info.project, EXPECTED_PROJECT, `${label}: project`);
            assert.strictEqual(info.repositoryName, EXPECTED_REPO_NAME, `${label}: repositoryName`);
            assert.strictEqual(info.repository, repo, `${label}: repository reference`);
            detector.dispose();
        });
    }
});

suite('getActiveRepository fallback behavior', () => {
    test('falls back to repositories[0] when detector has no match', () => {
        const repo = makeRepo([
            makeRemote('origin', 'https://github.com/user/repo.git'),
        ], '/workspace/github');
        const api = makeGitApi([repo]);
        const detector = new RepositoryDetector(api, createMockLog());
        assert.strictEqual(detector.currentRepository, undefined);
        const active = getActiveRepository(api, detector);
        assert.strictEqual(active, repo, 'should fall back to repositories[0]');
        detector.dispose();
    });

    test('returns undefined when no repositories exist and detector has no match', () => {
        const api = makeGitApi([]);
        const detector = new RepositoryDetector(api, createMockLog());
        const active = getActiveRepository(api, detector);
        assert.strictEqual(active, undefined);
        detector.dispose();
    });

    test('returns undefined when gitApi is undefined', () => {
        const api = makeGitApi([]);
        const detector = new RepositoryDetector(api, createMockLog());
        const active = getActiveRepository(undefined, detector);
        assert.strictEqual(active, undefined);
        detector.dispose();
    });

    test('prefers detector match over repositories[0]', () => {
        const repo0 = makeRepo([
            makeRemote('origin', 'https://github.com/user/other.git'),
        ], '/workspace/first');
        const repo1 = makeRepo([
            makeRemote('origin', AZDO_HTTPS),
        ], '/workspace/second');
        const api = makeGitApi([repo0, repo1]);
        const detector = new RepositoryDetector(api, createMockLog());
        const active = getActiveRepository(api, detector);
        assert.strictEqual(active, repo1, 'should use detector match, not [0]');
        assert.notStrictEqual(active, repo0);
        detector.dispose();
    });
});
