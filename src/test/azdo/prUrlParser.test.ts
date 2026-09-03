import * as assert from 'assert';
import { isSameAzDoRepository, parseAzDoPullRequestUrl } from '../../azdo/prUrlParser';

suite('parseAzDoPullRequestUrl', () => {
    test('parses a dev.azure.com pull request URL', () => {
        assert.deepStrictEqual(
            parseAzDoPullRequestUrl('https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/123'),
            {
                organization: 'myorg',
                project: 'myproject',
                repositoryName: 'myrepo',
                pullRequestId: 123,
                repositoryUrl: 'https://dev.azure.com/myorg/myproject/_git/myrepo',
            },
        );
    });

    test('parses encoded names and ignores query and fragment', () => {
        assert.deepStrictEqual(
            parseAzDoPullRequestUrl('https://dev.azure.com/my%20org/my%20project/_git/my%20repo/pullrequest/42?view=files#discussion'),
            {
                organization: 'my org',
                project: 'my project',
                repositoryName: 'my repo',
                pullRequestId: 42,
                repositoryUrl: 'https://dev.azure.com/my%20org/my%20project/_git/my%20repo',
            },
        );
    });

    test('parses a legacy visualstudio.com URL', () => {
        const parsed = parseAzDoPullRequestUrl(
            'https://myorg.visualstudio.com/DefaultCollection/myproject/_git/myrepo/pullrequest/7',
        );

        assert.strictEqual(parsed?.organization, 'myorg');
        assert.strictEqual(parsed?.project, 'myproject');
        assert.strictEqual(parsed?.repositoryName, 'myrepo');
        assert.strictEqual(parsed?.pullRequestId, 7);
    });

    for (const value of [
        '',
        'https://github.com/org/repo/pull/1',
        'https://dev.azure.com/org/project/_git/repo',
        'https://dev.azure.com/org/project/_git/repo/pullrequest/not-a-number',
        'https://dev.azure.com/org/project/_git/repo/pullrequest/0',
        'https://user:secret@dev.azure.com/org/project/_git/repo/pullrequest/1',
    ]) {
        test(`rejects ${value || 'an empty value'}`, () => {
            assert.strictEqual(parseAzDoPullRequestUrl(value), undefined);
        });
    }

    test('matches repository identity case-insensitively', () => {
        const parsed = parseAzDoPullRequestUrl('https://dev.azure.com/MyOrg/MyProject/_git/MyRepo/pullrequest/1')!;
        assert.strictEqual(isSameAzDoRepository(parsed, {
            organization: 'myorg',
            project: 'myproject',
            repositoryName: 'myrepo',
            remoteName: 'origin',
            remoteUrl: '',
            apiBaseUrl: '',
        }), true);
    });

    test('rejects a different repository identity', () => {
        const parsed = parseAzDoPullRequestUrl('https://dev.azure.com/org/project/_git/other/pullrequest/1')!;
        assert.strictEqual(isSameAzDoRepository(parsed, {
            organization: 'org',
            project: 'project',
            repositoryName: 'current',
            remoteName: 'origin',
            remoteUrl: '',
            apiBaseUrl: '',
        }), false);
    });
});