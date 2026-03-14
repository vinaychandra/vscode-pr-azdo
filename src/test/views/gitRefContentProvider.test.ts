import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitRefContentProvider, GIT_CONTENT_SCHEME, buildGitRefUri } from '../../views/gitRefContentProvider';

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

suite('buildGitRefUri', () => {
    test('builds URI with correct scheme', () => {
        const uri = buildGitRefUri('src/index.ts', 'origin/main');
        assert.strictEqual(uri.scheme, GIT_CONTENT_SCHEME);
    });

    test('encodes file path in URI path', () => {
        const uri = buildGitRefUri('src/index.ts', 'origin/main');
        assert.ok(uri.path.includes('src/index.ts'));
    });

    test('encodes ref in query parameter', () => {
        const uri = buildGitRefUri('src/index.ts', 'origin/main');
        const params = new URLSearchParams(uri.query);
        assert.strictEqual(params.get('ref'), 'origin/main');
    });

    test('handles special characters in ref', () => {
        const uri = buildGitRefUri('file.ts', 'origin/feature/my branch');
        const params = new URLSearchParams(uri.query);
        assert.strictEqual(params.get('ref'), 'origin/feature/my branch');
    });
});

suite('GitRefContentProvider', () => {
    test('returns empty string for __empty__ path', async () => {
        const provider = new GitRefContentProvider(createMockLog());
        const uri = buildGitRefUri('__empty__', 'origin/main');
        const content = await provider.provideTextDocumentContent(uri, new vscode.CancellationTokenSource().token);
        assert.strictEqual(content, '');
    });

    test('caches results', async () => {
        const provider = new GitRefContentProvider(createMockLog());
        const uri = buildGitRefUri('__empty__', 'origin/main');
        // Call twice — second should use cache
        await provider.provideTextDocumentContent(uri, new vscode.CancellationTokenSource().token);
        const content = await provider.provideTextDocumentContent(uri, new vscode.CancellationTokenSource().token);
        assert.strictEqual(content, '');
    });

    test('clearCache resets cached data', async () => {
        const provider = new GitRefContentProvider(createMockLog());
        const uri = buildGitRefUri('__empty__', 'origin/main');
        await provider.provideTextDocumentContent(uri, new vscode.CancellationTokenSource().token);
        provider.clearCache();
        // Should not throw after clearing
        const content = await provider.provideTextDocumentContent(uri, new vscode.CancellationTokenSource().token);
        assert.strictEqual(content, '');
    });
});

suite('GIT_CONTENT_SCHEME', () => {
    test('is azdo-pr-git', () => {
        assert.strictEqual(GIT_CONTENT_SCHEME, 'azdo-pr-git');
    });
});
