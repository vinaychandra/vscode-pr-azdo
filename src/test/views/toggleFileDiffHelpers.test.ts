import * as assert from 'assert';
import * as vscode from 'vscode';
import { VersionControlChangeType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { GIT_CONTENT_SCHEME, buildGitRefUri } from '../../views/gitRefContentProvider';
import {
    computeRelativePath,
    extractPathFromGitRefUri,
    getWorkspaceFileUriFromDiffInput,
    isUriInChangedFiles,
    buildDiffParams,
} from '../../views/toggleFileDiffHelpers';

// ---------------------------------------------------------------------------
// computeRelativePath
// ---------------------------------------------------------------------------

suite('computeRelativePath', () => {
    test('returns relative path for file under repo root', () => {
        const repoRoot = vscode.Uri.file('/home/user/repo');
        const fileUri = vscode.Uri.file('/home/user/repo/src/index.ts');
        assert.strictEqual(computeRelativePath(fileUri, repoRoot), 'src/index.ts');
    });

    test('returns root-level file name', () => {
        const repoRoot = vscode.Uri.file('/home/user/repo');
        const fileUri = vscode.Uri.file('/home/user/repo/README.md');
        assert.strictEqual(computeRelativePath(fileUri, repoRoot), 'README.md');
    });

    test('returns deeply nested path', () => {
        const repoRoot = vscode.Uri.file('/home/user/repo');
        const fileUri = vscode.Uri.file('/home/user/repo/src/views/components/Button.tsx');
        assert.strictEqual(computeRelativePath(fileUri, repoRoot), 'src/views/components/Button.tsx');
    });

    test('returns undefined for file outside repo root', () => {
        const repoRoot = vscode.Uri.file('/home/user/repo');
        const fileUri = vscode.Uri.file('/home/user/other-repo/src/index.ts');
        assert.strictEqual(computeRelativePath(fileUri, repoRoot), undefined);
    });

    test('returns undefined for completely unrelated path', () => {
        const repoRoot = vscode.Uri.file('/home/user/repo');
        const fileUri = vscode.Uri.file('/tmp/scratch.ts');
        assert.strictEqual(computeRelativePath(fileUri, repoRoot), undefined);
    });

    test('does not match partial directory names (repo vs repo-other)', () => {
        const repoRoot = vscode.Uri.file('/home/user/repo');
        const fileUri = vscode.Uri.file('/home/user/repo-other/src/index.ts');
        assert.strictEqual(computeRelativePath(fileUri, repoRoot), undefined);
    });

    test('handles Windows-style paths (drive letter)', () => {
        const repoRoot = vscode.Uri.file('C:\\Users\\dev\\project');
        const fileUri = vscode.Uri.file('C:\\Users\\dev\\project\\src\\app.ts');
        const result = computeRelativePath(fileUri, repoRoot);
        assert.strictEqual(result, 'src/app.ts');
    });

    test('handles Windows paths case-insensitively', () => {
        const repoRoot = vscode.Uri.file('C:\\Users\\Dev\\Project');
        const fileUri = vscode.Uri.file('c:\\users\\dev\\project\\src\\app.ts');
        assert.strictEqual(computeRelativePath(fileUri, repoRoot), 'src/app.ts');
    });

    test('handles Windows paths with different drive letters', () => {
        const repoRoot = vscode.Uri.file('C:\\Users\\dev\\project');
        const fileUri = vscode.Uri.file('D:\\Other\\file.ts');
        assert.strictEqual(computeRelativePath(fileUri, repoRoot), undefined);
    });

    test('handles repo opened from a subfolder (workspace root is below repo root)', () => {
        // User opens /home/user/repo/packages/frontend as their workspace
        // but the repo root is /home/user/repo
        const repoRoot = vscode.Uri.file('/home/user/repo');
        const fileUri = vscode.Uri.file('/home/user/repo/packages/frontend/src/App.tsx');
        assert.strictEqual(computeRelativePath(fileUri, repoRoot), 'packages/frontend/src/App.tsx');
    });

    test('handles spaces in path', () => {
        const repoRoot = vscode.Uri.file('/home/user/my project');
        const fileUri = vscode.Uri.file('/home/user/my project/src/index.ts');
        assert.strictEqual(computeRelativePath(fileUri, repoRoot), 'src/index.ts');
    });

    test('returns undefined when file URI equals repo root (no trailing file)', () => {
        const repoRoot = vscode.Uri.file('/home/user/repo');
        const fileUri = vscode.Uri.file('/home/user/repo');
        // The file path doesn't start with rootPath + '/' — it equals rootPath exactly
        assert.strictEqual(computeRelativePath(fileUri, repoRoot), undefined);
    });
});

// ---------------------------------------------------------------------------
// extractPathFromGitRefUri
// ---------------------------------------------------------------------------

suite('extractPathFromGitRefUri', () => {
    test('extracts path from git-ref URI', () => {
        const uri = buildGitRefUri('src/index.ts', 'origin/main');
        assert.strictEqual(extractPathFromGitRefUri(uri), 'src/index.ts');
    });

    test('returns undefined for __empty__', () => {
        const uri = buildGitRefUri('__empty__', 'origin/main');
        assert.strictEqual(extractPathFromGitRefUri(uri), undefined);
    });

    test('handles deeply nested path', () => {
        const uri = buildGitRefUri('src/views/components/Button.tsx', 'abc123');
        assert.strictEqual(extractPathFromGitRefUri(uri), 'src/views/components/Button.tsx');
    });

    test('handles root-level file', () => {
        const uri = buildGitRefUri('README.md', 'HEAD');
        assert.strictEqual(extractPathFromGitRefUri(uri), 'README.md');
    });
});

suite('getWorkspaceFileUriFromDiffInput', () => {
    test('returns the modified file URI when the active tab is a diff', () => {
        const fileUri = vscode.Uri.file('/home/user/repo/src/index.ts');
        const input = new vscode.TabInputTextDiff(
            buildGitRefUri('src/index.ts', 'origin/main'),
            fileUri,
        );

        assert.strictEqual(getWorkspaceFileUriFromDiffInput(input), fileUri);
    });

    test('returns undefined for a regular file tab input', () => {
        const input = new vscode.TabInputText(vscode.Uri.file('/home/user/repo/src/index.ts'));

        assert.strictEqual(getWorkspaceFileUriFromDiffInput(input), undefined);
    });

    test('returns undefined when neither diff side is a workspace file', () => {
        const input = new vscode.TabInputTextDiff(
            buildGitRefUri('src/deleted.ts', 'origin/main'),
            buildGitRefUri('__empty__', 'origin/main'),
        );

        assert.strictEqual(getWorkspaceFileUriFromDiffInput(input), undefined);
    });
});

// ---------------------------------------------------------------------------
// isUriInChangedFiles
// ---------------------------------------------------------------------------

suite('isUriInChangedFiles', () => {
    const repoRoot = vscode.Uri.file('/home/user/repo');
    const changedPaths = ['src/index.ts', 'README.md', 'src/views/App.tsx'];

    test('returns true for file:// URI of a changed file', () => {
        const uri = vscode.Uri.file('/home/user/repo/src/index.ts');
        assert.strictEqual(isUriInChangedFiles(uri, repoRoot, changedPaths), true);
    });

    test('returns false for file:// URI of an unchanged file', () => {
        const uri = vscode.Uri.file('/home/user/repo/src/other.ts');
        assert.strictEqual(isUriInChangedFiles(uri, repoRoot, changedPaths), false);
    });

    test('returns true for git-ref URI of a changed file', () => {
        const uri = buildGitRefUri('src/index.ts', 'origin/main');
        assert.strictEqual(isUriInChangedFiles(uri, repoRoot, changedPaths), true);
    });

    test('returns false for git-ref URI of an unchanged file', () => {
        const uri = buildGitRefUri('src/other.ts', 'origin/main');
        assert.strictEqual(isUriInChangedFiles(uri, repoRoot, changedPaths), false);
    });

    test('returns false for __empty__ git-ref URI', () => {
        const uri = buildGitRefUri('__empty__', 'origin/main');
        assert.strictEqual(isUriInChangedFiles(uri, repoRoot, changedPaths), false);
    });

    test('returns false for unknown URI scheme', () => {
        const uri = vscode.Uri.parse('untitled:Untitled-1');
        assert.strictEqual(isUriInChangedFiles(uri, repoRoot, changedPaths), false);
    });

    test('returns false when repoRoot is undefined (file scheme)', () => {
        const uri = vscode.Uri.file('/home/user/repo/src/index.ts');
        assert.strictEqual(isUriInChangedFiles(uri, undefined, changedPaths), false);
    });

    test('returns true for git-ref URI even when repoRoot is undefined', () => {
        // git-ref scheme doesn't need repoRoot for path extraction
        const uri = buildGitRefUri('src/index.ts', 'origin/main');
        assert.strictEqual(isUriInChangedFiles(uri, undefined, changedPaths), true);
    });

    test('works with Windows paths', () => {
        const winRoot = vscode.Uri.file('D:\\Work\\project');
        const uri = vscode.Uri.file('D:\\Work\\project\\src\\index.ts');
        assert.strictEqual(isUriInChangedFiles(uri, winRoot, changedPaths), true);
    });

    test('rejects file outside repo root', () => {
        const uri = vscode.Uri.file('/home/user/other/src/index.ts');
        assert.strictEqual(isUriInChangedFiles(uri, repoRoot, changedPaths), false);
    });

    test('works with subfolder: file under repo root but opened from subfolder', () => {
        // Even if workspace is opened from a subfolder, repoRoot is the git root
        const uri = vscode.Uri.file('/home/user/repo/src/views/App.tsx');
        assert.strictEqual(isUriInChangedFiles(uri, repoRoot, changedPaths), true);
    });
});

// ---------------------------------------------------------------------------
// buildDiffParams
// ---------------------------------------------------------------------------

suite('buildDiffParams', () => {
    const repoRoot = vscode.Uri.file('/home/user/repo');
    const targetRef = 'origin/main';
    const targetBranch = 'main';

    test('Edit: left is git-ref, right is working copy', () => {
        const diff = buildDiffParams('src/index.ts', VersionControlChangeType.Edit, repoRoot, targetRef, targetBranch);
        assert.strictEqual(diff.leftUri.scheme, GIT_CONTENT_SCHEME);
        assert.ok(diff.leftUri.path.includes('src/index.ts'));
        assert.strictEqual(new URLSearchParams(diff.leftUri.query).get('ref'), targetRef);
        assert.strictEqual(diff.rightUri.scheme, 'file');
        assert.ok(diff.rightUri.path.endsWith('src/index.ts'));
        assert.strictEqual(diff.title, 'index.ts (main ↔ Working Copy)');
    });

    test('Add: left is empty, right is working copy', () => {
        const diff = buildDiffParams('src/new.ts', VersionControlChangeType.Add, repoRoot, targetRef, targetBranch);
        assert.ok(diff.leftUri.path.includes('__empty__'));
        assert.strictEqual(diff.rightUri.scheme, 'file');
        assert.ok(diff.rightUri.path.endsWith('src/new.ts'));
        assert.strictEqual(diff.title, 'new.ts (Added)');
    });

    test('Delete: left is git-ref, right is empty', () => {
        const diff = buildDiffParams('src/old.ts', VersionControlChangeType.Delete, repoRoot, targetRef, targetBranch);
        assert.ok(diff.leftUri.path.includes('src/old.ts'));
        assert.strictEqual(diff.leftUri.scheme, GIT_CONTENT_SCHEME);
        assert.ok(diff.rightUri.path.includes('__empty__'));
        assert.strictEqual(diff.title, 'old.ts (Deleted)');
    });

    test('Rename (bitmask with Edit): treated as edit', () => {
        // Rename is often VersionControlChangeType.Rename | VersionControlChangeType.Edit
        // Neither Add nor Delete bit is set, so it falls through to the edit case
        const changeType = VersionControlChangeType.Rename as number as VersionControlChangeType;
        const diff = buildDiffParams('src/renamed.ts', changeType, repoRoot, targetRef, targetBranch);
        assert.strictEqual(diff.leftUri.scheme, GIT_CONTENT_SCHEME);
        assert.strictEqual(diff.rightUri.scheme, 'file');
        assert.strictEqual(diff.title, 'renamed.ts (main ↔ Working Copy)');
    });

    test('uses file name from deeply nested path', () => {
        const diff = buildDiffParams('src/views/components/Button.tsx', VersionControlChangeType.Edit, repoRoot, targetRef, targetBranch);
        assert.strictEqual(diff.title, 'Button.tsx (main ↔ Working Copy)');
    });

    test('root-level file uses file name as-is', () => {
        const diff = buildDiffParams('package.json', VersionControlChangeType.Edit, repoRoot, targetRef, targetBranch);
        assert.strictEqual(diff.title, 'package.json (main ↔ Working Copy)');
    });

    test('Windows repo root builds valid URIs', () => {
        const winRoot = vscode.Uri.file('D:\\Work\\project');
        const diff = buildDiffParams('src/app.ts', VersionControlChangeType.Edit, winRoot, targetRef, targetBranch);
        assert.strictEqual(diff.leftUri.scheme, GIT_CONTENT_SCHEME);
        assert.strictEqual(diff.rightUri.scheme, 'file');
        assert.ok(diff.rightUri.fsPath.endsWith('app.ts'), `Expected fsPath to end with app.ts, got: ${diff.rightUri.fsPath}`);
    });

    test('custom target branch appears in title', () => {
        const diff = buildDiffParams('src/index.ts', VersionControlChangeType.Edit, repoRoot, 'origin/develop', 'develop');
        assert.strictEqual(diff.title, 'index.ts (develop ↔ Working Copy)');
    });

    test('Add with bitmask (Add | Edit) treated as Add', () => {
        // Some AzDO responses combine flags
        const changeType = (VersionControlChangeType.Add | VersionControlChangeType.Edit) as VersionControlChangeType;
        const diff = buildDiffParams('src/new.ts', changeType, repoRoot, targetRef, targetBranch);
        assert.strictEqual(diff.title, 'new.ts (Added)');
        assert.ok(diff.leftUri.path.includes('__empty__'));
    });
});
