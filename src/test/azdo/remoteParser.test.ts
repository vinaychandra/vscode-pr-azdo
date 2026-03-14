import * as assert from 'assert';
import { parseAzDoRemote } from '../../azdo/remoteParser';

suite('parseAzDoRemote', () => {
    // ------------------------------------------------------------------
    // HTTPS – dev.azure.com
    // ------------------------------------------------------------------
    suite('dev.azure.com HTTPS', () => {
        test('standard URL', () => {
            const info = parseAzDoRemote(
                'https://dev.azure.com/myorg/myproject/_git/myrepo',
                'origin',
            );
            assert.ok(info);
            assert.strictEqual(info.organization, 'myorg');
            assert.strictEqual(info.project, 'myproject');
            assert.strictEqual(info.repositoryName, 'myrepo');
            assert.strictEqual(info.remoteName, 'origin');
            assert.strictEqual(info.apiBaseUrl, 'https://dev.azure.com/myorg');
        });

        test('URL with trailing slash', () => {
            const info = parseAzDoRemote(
                'https://dev.azure.com/myorg/myproject/_git/myrepo/',
                'origin',
            );
            assert.ok(info);
            assert.strictEqual(info.repositoryName, 'myrepo');
        });

        test('URL with .git suffix', () => {
            const info = parseAzDoRemote(
                'https://dev.azure.com/myorg/myproject/_git/myrepo.git',
                'origin',
            );
            assert.ok(info);
            assert.strictEqual(info.repositoryName, 'myrepo');
        });

        test('URL with embedded credentials (user@)', () => {
            const info = parseAzDoRemote(
                'https://user@dev.azure.com/myorg/myproject/_git/myrepo',
                'origin',
            );
            assert.ok(info);
            assert.strictEqual(info.organization, 'myorg');
            assert.strictEqual(info.project, 'myproject');
            assert.strictEqual(info.repositoryName, 'myrepo');
        });

        test('HTTP (non-TLS) URL', () => {
            const info = parseAzDoRemote(
                'http://dev.azure.com/myorg/myproject/_git/myrepo',
                'origin',
            );
            assert.ok(info);
            assert.strictEqual(info.organization, 'myorg');
        });
    });

    // ------------------------------------------------------------------
    // HTTPS – visualstudio.com
    // ------------------------------------------------------------------
    suite('visualstudio.com HTTPS', () => {
        test('standard URL', () => {
            const info = parseAzDoRemote(
                'https://myorg.visualstudio.com/myproject/_git/myrepo',
                'origin',
            );
            assert.ok(info);
            assert.strictEqual(info.organization, 'myorg');
            assert.strictEqual(info.project, 'myproject');
            assert.strictEqual(info.repositoryName, 'myrepo');
            assert.strictEqual(info.apiBaseUrl, 'https://dev.azure.com/myorg');
        });

        test('URL with DefaultCollection', () => {
            const info = parseAzDoRemote(
                'https://myorg.visualstudio.com/DefaultCollection/myproject/_git/myrepo',
                'origin',
            );
            assert.ok(info);
            assert.strictEqual(info.organization, 'myorg');
            assert.strictEqual(info.project, 'myproject');
            assert.strictEqual(info.repositoryName, 'myrepo');
        });

        test('URL with trailing slash', () => {
            const info = parseAzDoRemote(
                'https://myorg.visualstudio.com/myproject/_git/myrepo/',
                'upstream',
            );
            assert.ok(info);
            assert.strictEqual(info.remoteName, 'upstream');
        });

        test('URL with .git suffix', () => {
            const info = parseAzDoRemote(
                'https://myorg.visualstudio.com/myproject/_git/myrepo.git',
                'origin',
            );
            assert.ok(info);
            assert.strictEqual(info.repositoryName, 'myrepo');
        });

        test('URL with embedded credentials', () => {
            const info = parseAzDoRemote(
                'https://user@myorg.visualstudio.com/myproject/_git/myrepo',
                'origin',
            );
            assert.ok(info);
            assert.strictEqual(info.organization, 'myorg');
        });
    });

    // ------------------------------------------------------------------
    // SSH – ssh.dev.azure.com
    // ------------------------------------------------------------------
    suite('ssh.dev.azure.com SSH', () => {
        test('standard URL', () => {
            const info = parseAzDoRemote(
                'git@ssh.dev.azure.com:v3/myorg/myproject/myrepo',
                'origin',
            );
            assert.ok(info);
            assert.strictEqual(info.organization, 'myorg');
            assert.strictEqual(info.project, 'myproject');
            assert.strictEqual(info.repositoryName, 'myrepo');
            assert.strictEqual(info.apiBaseUrl, 'https://dev.azure.com/myorg');
        });

        test('URL with .git suffix', () => {
            const info = parseAzDoRemote(
                'git@ssh.dev.azure.com:v3/myorg/myproject/myrepo.git',
                'origin',
            );
            assert.ok(info);
            assert.strictEqual(info.repositoryName, 'myrepo');
        });
    });

    // ------------------------------------------------------------------
    // SSH – legacy vs-ssh.visualstudio.com
    // ------------------------------------------------------------------
    suite('vs-ssh.visualstudio.com SSH (legacy)', () => {
        test('standard URL', () => {
            const info = parseAzDoRemote(
                'git@vs-ssh.visualstudio.com:v3/myorg/myproject/myrepo',
                'origin',
            );
            assert.ok(info);
            assert.strictEqual(info.organization, 'myorg');
            assert.strictEqual(info.project, 'myproject');
            assert.strictEqual(info.repositoryName, 'myrepo');
            assert.strictEqual(info.apiBaseUrl, 'https://dev.azure.com/myorg');
        });
    });

    // ------------------------------------------------------------------
    // Non-AzDO URLs → should return undefined
    // ------------------------------------------------------------------
    suite('non-AzDO URLs', () => {
        const nonAzDoUrls = [
            'https://github.com/user/repo.git',
            'git@github.com:user/repo.git',
            'https://gitlab.com/user/repo.git',
            'https://bitbucket.org/user/repo.git',
            'https://example.com/some/path',
            '',
        ];

        for (const url of nonAzDoUrls) {
            test(`returns undefined for: ${url || '(empty string)'}`, () => {
                const info = parseAzDoRemote(url, 'origin');
                assert.strictEqual(info, undefined);
            });
        }
    });

    // ------------------------------------------------------------------
    // Edge cases
    // ------------------------------------------------------------------
    suite('edge cases', () => {
        test('URL-encoded characters in org/project/repo', () => {
            const info = parseAzDoRemote(
                'https://dev.azure.com/my%20org/my%20project/_git/my%20repo',
                'origin',
            );
            assert.ok(info);
            assert.strictEqual(info.organization, 'my org');
            assert.strictEqual(info.project, 'my project');
            assert.strictEqual(info.repositoryName, 'my repo');
        });

        test('preserves original remote URL', () => {
            const url = 'https://dev.azure.com/org/proj/_git/repo';
            const info = parseAzDoRemote(url, 'origin');
            assert.ok(info);
            assert.strictEqual(info.remoteUrl, url);
        });

        test('case-insensitive host matching', () => {
            const info = parseAzDoRemote(
                'https://Dev.Azure.Com/myorg/myproject/_git/myrepo',
                'origin',
            );
            assert.ok(info);
            assert.strictEqual(info.organization, 'myorg');
        });
    });
});
