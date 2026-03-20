import * as assert from 'assert';
import type * as vscode from 'vscode';
import { buildGitDiffArgs, getReviewOptions, reviewModeLabel, type GitWorkspaceState } from '../../git/gitStateDetector';
import type { ReviewQuickPickItem } from '../../git/gitStateDetector';

// ---------------------------------------------------------------------------
// buildGitDiffArgs
// ---------------------------------------------------------------------------
suite('buildGitDiffArgs', () => {
    test('staged → git diff --cached', () => {
        const args = buildGitDiffArgs('staged', 'origin/main', 'origin/feature', []);
        assert.deepStrictEqual(args, ['diff', '--cached']);
    });

    test('unstaged → git diff (no args)', () => {
        const args = buildGitDiffArgs('unstaged', 'origin/main', 'origin/feature', []);
        assert.deepStrictEqual(args, ['diff']);
    });

    test('all-uncommitted → git diff HEAD', () => {
        const args = buildGitDiffArgs('all-uncommitted', 'origin/main', 'origin/feature', []);
        assert.deepStrictEqual(args, ['diff', 'HEAD']);
    });

    test('unpushed-commits → git diff origin/feature..HEAD', () => {
        const args = buildGitDiffArgs('unpushed-commits', 'origin/main', 'origin/feature', []);
        assert.deepStrictEqual(args, ['diff', 'origin/feature..HEAD']);
    });

    test('unpushed-commits with undefined currentBranchRef falls back', () => {
        const args = buildGitDiffArgs('unpushed-commits', 'origin/main', undefined, []);
        assert.deepStrictEqual(args, ['diff', 'origin/HEAD..HEAD']);
    });

    test('vs-target with files → git diff origin/main -- file1 file2', () => {
        const args = buildGitDiffArgs('vs-target', 'origin/main', 'origin/feature', ['src/a.ts', 'src/b.ts']);
        assert.deepStrictEqual(args, ['diff', 'origin/main', '--', 'src/a.ts', 'src/b.ts']);
    });

    test('vs-target without files → git diff origin/main', () => {
        const args = buildGitDiffArgs('vs-target', 'origin/main', 'origin/feature', []);
        assert.deepStrictEqual(args, ['diff', 'origin/main']);
    });

    test('staged ignores file paths', () => {
        const args = buildGitDiffArgs('staged', 'origin/main', 'origin/feature', ['a.ts']);
        assert.deepStrictEqual(args, ['diff', '--cached']);
    });
});

// ---------------------------------------------------------------------------
// getReviewOptions
// ---------------------------------------------------------------------------

/** Minimal mock log that captures messages. */
function createMockLog(): { log: vscode.OutputChannel; messages: string[] } {
    const messages: string[] = [];
    return {
        log: { appendLine: (msg: string) => { messages.push(msg); } } as unknown as vscode.OutputChannel,
        messages,
    };
}

function modes(items: ReviewQuickPickItem[]): string[] {
    return items.map(i => i.reviewMode);
}

suite('getReviewOptions', () => {
    test('Scenario 1: clean + pushed → returns undefined (auto-proceed)', () => {
        const { log } = createMockLog();
        const state: GitWorkspaceState = {
            hasStagedChanges: false,
            hasUnstagedChanges: false,
            hasUnpushedCommits: false,
            currentBranch: 'feature',
            headSha: 'abc123',
            remoteBranchSha: 'abc123',
        };
        assert.strictEqual(getReviewOptions(state, 'main', log), undefined);
    });

    test('Scenario 2: clean + unpushed → 2 options', () => {
        const { log } = createMockLog();
        const state: GitWorkspaceState = {
            hasStagedChanges: false,
            hasUnstagedChanges: false,
            hasUnpushedCommits: true,
            currentBranch: 'feature',
            headSha: 'abc123',
            remoteBranchSha: 'def456',
        };
        const options = getReviewOptions(state, 'main', log);
        assert.ok(options);
        assert.strictEqual(options.length, 2);
        assert.deepStrictEqual(modes(options), ['unpushed-commits', 'vs-target']);
    });

    test('Scenario 3: dirty with only staged changes, no unpushed commits', () => {
        const { log } = createMockLog();
        const state: GitWorkspaceState = {
            hasStagedChanges: true,
            hasUnstagedChanges: false,
            hasUnpushedCommits: false,
            currentBranch: 'feature',
            headSha: 'abc123',
            remoteBranchSha: 'abc123',
        };
        const options = getReviewOptions(state, 'main', log);
        assert.ok(options);
        // staged + all-uncommitted + vs-target (no unstaged, no unpushed)
        assert.deepStrictEqual(modes(options), ['staged', 'all-uncommitted', 'vs-target']);
    });

    test('Scenario 3: dirty with only unstaged changes, no unpushed commits', () => {
        const { log } = createMockLog();
        const state: GitWorkspaceState = {
            hasStagedChanges: false,
            hasUnstagedChanges: true,
            hasUnpushedCommits: false,
            currentBranch: 'feature',
            headSha: 'abc123',
            remoteBranchSha: 'abc123',
        };
        const options = getReviewOptions(state, 'main', log);
        assert.ok(options);
        // unstaged + all-uncommitted + vs-target
        assert.deepStrictEqual(modes(options), ['unstaged', 'all-uncommitted', 'vs-target']);
    });

    test('Scenario 3: dirty with staged + unstaged + unpushed', () => {
        const { log } = createMockLog();
        const state: GitWorkspaceState = {
            hasStagedChanges: true,
            hasUnstagedChanges: true,
            hasUnpushedCommits: true,
            currentBranch: 'feature',
            headSha: 'abc123',
            remoteBranchSha: 'def456',
        };
        const options = getReviewOptions(state, 'main', log);
        assert.ok(options);
        // all 5 options
        assert.deepStrictEqual(
            modes(options),
            ['staged', 'unstaged', 'all-uncommitted', 'unpushed-commits', 'vs-target'],
        );
    });

    test('Scenario 3: dirty, unstaged only, with unpushed commits', () => {
        const { log } = createMockLog();
        const state: GitWorkspaceState = {
            hasStagedChanges: false,
            hasUnstagedChanges: true,
            hasUnpushedCommits: true,
            currentBranch: 'feature',
            headSha: 'abc123',
            remoteBranchSha: 'def456',
        };
        const options = getReviewOptions(state, 'main', log);
        assert.ok(options);
        // unstaged + all-uncommitted + unpushed-commits + vs-target (no staged)
        assert.deepStrictEqual(
            modes(options),
            ['unstaged', 'all-uncommitted', 'unpushed-commits', 'vs-target'],
        );
    });
});

// ---------------------------------------------------------------------------
// reviewModeLabel
// ---------------------------------------------------------------------------
suite('reviewModeLabel', () => {
    test('staged', () => {
        assert.strictEqual(reviewModeLabel('staged'), 'staged changes');
    });

    test('unstaged', () => {
        assert.strictEqual(reviewModeLabel('unstaged'), 'unstaged changes');
    });

    test('all-uncommitted', () => {
        assert.strictEqual(reviewModeLabel('all-uncommitted'), 'all uncommitted changes vs last commit');
    });

    test('unpushed-commits', () => {
        assert.strictEqual(reviewModeLabel('unpushed-commits'), 'unpushed commits');
    });

    test('vs-target with branch name', () => {
        assert.strictEqual(reviewModeLabel('vs-target', 'main'), 'changes vs main');
    });

    test('vs-target without branch name', () => {
        assert.strictEqual(reviewModeLabel('vs-target'), 'changes vs target branch');
    });
});
