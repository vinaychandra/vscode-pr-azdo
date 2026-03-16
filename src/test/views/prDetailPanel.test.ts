import * as assert from 'assert';
import { escapeHtml, voteLabel, prStatusLabel, mergeStatusLabel, buildPrWebUrl, buildCreatePrUrl, buildHtml } from '../../views/prDetailPanel';
import { PullRequestStatus, PullRequestAsyncStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { AzDoRemoteInfo } from '../../azdo/remoteInfo';

suite('escapeHtml', () => {
    test('escapes ampersands', () => {
        assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
    });

    test('escapes less-than', () => {
        assert.strictEqual(escapeHtml('<script>'), '&lt;script&gt;');
    });

    test('escapes greater-than', () => {
        assert.strictEqual(escapeHtml('a > b'), 'a &gt; b');
    });

    test('escapes double quotes', () => {
        assert.strictEqual(escapeHtml('"hello"'), '&quot;hello&quot;');
    });

    test('handles empty string', () => {
        assert.strictEqual(escapeHtml(''), '');
    });

    test('handles string with no special characters', () => {
        assert.strictEqual(escapeHtml('hello world'), 'hello world');
    });

    test('escapes multiple special characters together', () => {
        assert.strictEqual(
            escapeHtml('<a href="x">foo & bar</a>'),
            '&lt;a href=&quot;x&quot;&gt;foo &amp; bar&lt;/a&gt;',
        );
    });
});

suite('voteLabel', () => {
    test('approved (10)', () => {
        assert.strictEqual(voteLabel(10), '✅ Approved');
    });

    test('approved with suggestions (5)', () => {
        assert.strictEqual(voteLabel(5), '✅ Approved with suggestions');
    });

    test('no vote (0)', () => {
        assert.strictEqual(voteLabel(0), '⏳ No vote');
    });

    test('waiting for author (-5)', () => {
        assert.strictEqual(voteLabel(-5), '⏸️ Waiting for author');
    });

    test('rejected (-10)', () => {
        assert.strictEqual(voteLabel(-10), '❌ Rejected');
    });

    test('unknown vote value', () => {
        assert.strictEqual(voteLabel(99), 'Vote: 99');
    });
});

suite('prStatusLabel', () => {
    test('Active', () => {
        assert.strictEqual(prStatusLabel(PullRequestStatus.Active), 'Active');
    });

    test('Completed', () => {
        assert.strictEqual(prStatusLabel(PullRequestStatus.Completed), 'Completed');
    });

    test('Abandoned', () => {
        assert.strictEqual(prStatusLabel(PullRequestStatus.Abandoned), 'Abandoned');
    });

    test('undefined', () => {
        assert.strictEqual(prStatusLabel(undefined), 'Unknown');
    });
});

suite('mergeStatusLabel', () => {
    test('Succeeded', () => {
        assert.strictEqual(mergeStatusLabel(PullRequestAsyncStatus.Succeeded), '✅ Ready to merge');
    });

    test('Conflicts', () => {
        assert.strictEqual(mergeStatusLabel(PullRequestAsyncStatus.Conflicts), '⚠️ Merge conflicts');
    });

    test('RejectedByPolicy', () => {
        assert.strictEqual(mergeStatusLabel(PullRequestAsyncStatus.RejectedByPolicy), '🚫 Rejected by policy');
    });

    test('Failure', () => {
        assert.strictEqual(mergeStatusLabel(PullRequestAsyncStatus.Failure), '❌ Merge failed');
    });

    test('Queued', () => {
        assert.strictEqual(mergeStatusLabel(PullRequestAsyncStatus.Queued), '⏳ Merge queued');
    });

    test('NotSet', () => {
        assert.strictEqual(mergeStatusLabel(PullRequestAsyncStatus.NotSet), '—');
    });

    test('undefined', () => {
        assert.strictEqual(mergeStatusLabel(undefined), '—');
    });
});

suite('buildPrWebUrl', () => {
    const remoteInfo: AzDoRemoteInfo = {
        organization: 'myorg',
        project: 'myproject',
        repositoryName: 'myrepo',
        remoteUrl: 'https://dev.azure.com/myorg/myproject/_git/myrepo',
        remoteName: 'origin',
        apiBaseUrl: 'https://dev.azure.com/myorg',
    };

    test('builds correct URL', () => {
        assert.strictEqual(
            buildPrWebUrl(remoteInfo, 42),
            'https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/42',
        );
    });

    test('encodes special characters in org/project/repo', () => {
        const info: AzDoRemoteInfo = {
            ...remoteInfo,
            organization: 'my org',
            project: 'my project',
            repositoryName: 'my repo',
        };
        const url = buildPrWebUrl(info, 1);
        assert.ok(url.includes('my%20org'));
        assert.ok(url.includes('my%20project'));
        assert.ok(url.includes('my%20repo'));
    });
});

suite('buildCreatePrUrl', () => {
    const remoteInfo: AzDoRemoteInfo = {
        organization: 'myorg',
        project: 'myproject',
        repositoryName: 'myrepo',
        remoteUrl: 'https://dev.azure.com/myorg/myproject/_git/myrepo',
        remoteName: 'origin',
        apiBaseUrl: 'https://dev.azure.com/myorg',
    };

    test('builds correct create-PR URL', () => {
        const url = buildCreatePrUrl(remoteInfo, 'feature/x', 'main');
        assert.strictEqual(
            url,
            'https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequestcreate?sourceRef=feature%2Fx&targetRef=main',
        );
    });

    test('encodes special characters in branch names', () => {
        const url = buildCreatePrUrl(remoteInfo, 'my branch', 'main target');
        assert.ok(url.includes('sourceRef=my%20branch'));
        assert.ok(url.includes('targetRef=main%20target'));
    });

    test('encodes special characters in org/project/repo', () => {
        const info: AzDoRemoteInfo = {
            ...remoteInfo,
            organization: 'my org',
            project: 'my project',
            repositoryName: 'my repo',
        };
        const url = buildCreatePrUrl(info, 'feat', 'main');
        assert.ok(url.includes('my%20org'));
        assert.ok(url.includes('my%20project'));
        assert.ok(url.includes('my%20repo'));
    });

    test('handles simple branch names', () => {
        const url = buildCreatePrUrl(remoteInfo, 'develop', 'main');
        assert.ok(url.includes('sourceRef=develop'));
        assert.ok(url.includes('targetRef=main'));
    });
});

suite('buildHtml', () => {
    const remoteInfo: AzDoRemoteInfo = {
        organization: 'myorg',
        project: 'myproject',
        repositoryName: 'myrepo',
        remoteUrl: 'https://dev.azure.com/myorg/myproject/_git/myrepo',
        remoteName: 'origin',
        apiBaseUrl: 'https://dev.azure.com/myorg',
    };

    function makePr(overrides: Partial<GitPullRequest> = {}): GitPullRequest {
        return {
            pullRequestId: 42,
            title: 'Test PR',
            sourceRefName: 'refs/heads/feature',
            targetRefName: 'refs/heads/main',
            isDraft: false,
            status: PullRequestStatus.Active,
            createdBy: { displayName: 'Alice', ...({} as any) },
            creationDate: new Date('2026-01-01T00:00:00Z'),
            ...overrides,
        };
    }

    test('contains PR title', () => {
        const html = buildHtml(makePr(), remoteInfo);
        assert.ok(html.includes('Test PR'));
    });

    test('contains PR number', () => {
        const html = buildHtml(makePr(), remoteInfo);
        assert.ok(html.includes('#42'));
    });

    test('contains author name', () => {
        const html = buildHtml(makePr(), remoteInfo);
        assert.ok(html.includes('Alice'));
    });

    test('contains branch names without refs/heads/', () => {
        const html = buildHtml(makePr(), remoteInfo);
        assert.ok(html.includes('feature'));
        assert.ok(html.includes('main'));
        assert.ok(!html.includes('refs/heads/'));
    });

    test('contains action buttons', () => {
        const html = buildHtml(makePr(), remoteInfo);
        assert.ok(html.includes('Approve'));
        assert.ok(html.includes('Reject'));
        assert.ok(html.includes('Open in Browser'));
        assert.ok(html.includes('Copy Link'));
    });

    test('shows Draft badge when isDraft', () => {
        const html = buildHtml(makePr({ isDraft: true }), remoteInfo);
        assert.ok(html.includes('Draft'));
    });

    test('shows reviewers with votes', () => {
        const html = buildHtml(makePr({
            reviewers: [
                { displayName: 'Bob', vote: 10, isRequired: true, ...({} as any) },
                { displayName: 'Carol', vote: -10, isRequired: false, ...({} as any) },
            ],
        }), remoteInfo);
        assert.ok(html.includes('Bob'));
        assert.ok(html.includes('Required'));
        assert.ok(html.includes('Approved'));
        assert.ok(html.includes('Carol'));
        assert.ok(html.includes('Rejected'));
    });

    test('shows labels', () => {
        const html = buildHtml(makePr({
            labels: [{ name: 'bug', active: true }, { name: 'inactive', active: false }],
        }), remoteInfo);
        assert.ok(html.includes('bug'));
        assert.ok(!html.includes('inactive'));
    });

    test('shows auto-complete info', () => {
        const html = buildHtml(makePr({
            autoCompleteSetBy: { displayName: 'Dave', ...({} as any) },
            completionOptions: { squashMerge: true, deleteSourceBranch: true },
        }), remoteInfo);
        assert.ok(html.includes('Dave'));
        assert.ok(html.includes('Squash merge'));
        assert.ok(html.includes('Delete source branch'));
    });

    test('shows work items', () => {
        const html = buildHtml(makePr({
            workItemRefs: [{ id: '123', url: '' }, { id: '456', url: '' }],
        }), remoteInfo);
        assert.ok(html.includes('#123'));
        assert.ok(html.includes('#456'));
    });

    test('shows merge status', () => {
        const html = buildHtml(makePr({
            mergeStatus: PullRequestAsyncStatus.Conflicts,
        }), remoteInfo);
        assert.ok(html.includes('Merge conflicts'));
    });

    test('shows closed date when present', () => {
        const html = buildHtml(makePr({
            closedDate: new Date('2026-02-01T00:00:00Z'),
        }), remoteInfo);
        assert.ok(html.includes('Closed'));
    });

    test('escapes HTML in description to prevent XSS', () => {
        const html = buildHtml(makePr({
            description: '<script>alert("xss")</script>',
        }), remoteInfo);
        assert.ok(!html.includes('<script>alert'));
        assert.ok(html.includes('&lt;script&gt;'));
    });

    test('contains Content-Security-Policy', () => {
        const html = buildHtml(makePr(), remoteInfo);
        assert.ok(html.includes('Content-Security-Policy'));
    });
});
