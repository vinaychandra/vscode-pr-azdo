import * as assert from 'assert';
import {
    buildFileTree,
    changeTypeLabel,
    FolderItem,
    FileChangeItem,
    ActivePrRootItem,
    SectionHeaderItem,
    CommitItem,
} from '../../views/activePrTreeItems';
import { VersionControlChangeType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { GitPullRequestChange, GitCommitRef } from 'azure-devops-node-api/interfaces/GitInterfaces';
import * as vscode from 'vscode';

// Helper to create a fake change
function makeChange(path: string, changeType: VersionControlChangeType = VersionControlChangeType.Edit): GitPullRequestChange {
    return { item: { path }, changeType } as any;
}

suite('changeTypeLabel', () => {
    test('Add', () => {
        assert.strictEqual(changeTypeLabel(VersionControlChangeType.Add), 'Add');
    });

    test('Edit', () => {
        assert.strictEqual(changeTypeLabel(VersionControlChangeType.Edit), 'Edit');
    });

    test('Delete', () => {
        assert.strictEqual(changeTypeLabel(VersionControlChangeType.Delete), 'Delete');
    });

    test('Rename', () => {
        assert.strictEqual(changeTypeLabel(VersionControlChangeType.Rename), 'Rename');
    });

    test('Merge', () => {
        assert.strictEqual(changeTypeLabel(VersionControlChangeType.Merge), 'Merge');
    });

    test('combined flags prefers Add over Edit', () => {
        assert.strictEqual(
            changeTypeLabel(VersionControlChangeType.Add | VersionControlChangeType.Edit),
            'Add',
        );
    });

    test('None returns empty string', () => {
        assert.strictEqual(changeTypeLabel(VersionControlChangeType.None), '');
    });
});

suite('buildFileTree', () => {
    test('empty changes returns empty tree', () => {
        const tree = buildFileTree([]);
        assert.strictEqual(tree.length, 0);
    });

    test('single root-level file', () => {
        const tree = buildFileTree([makeChange('/README.md')]);
        assert.strictEqual(tree.length, 1);
        assert.ok(tree[0] instanceof FileChangeItem);
        assert.strictEqual((tree[0] as FileChangeItem).fileName, 'README.md');
    });

    test('files in a folder', () => {
        const tree = buildFileTree([
            makeChange('/src/index.ts'),
            makeChange('/src/utils.ts'),
        ]);
        assert.strictEqual(tree.length, 1);
        assert.ok(tree[0] instanceof FolderItem);
        assert.strictEqual((tree[0] as FolderItem).folderName, 'src');
        assert.strictEqual((tree[0] as FolderItem).children.length, 2);
    });

    test('compacts single-child intermediate folders', () => {
        const tree = buildFileTree([
            makeChange('/src/components/Button.tsx'),
        ]);
        assert.strictEqual(tree.length, 1);
        assert.ok(tree[0] instanceof FolderItem);
        // Should compact "src" → "src/components"
        assert.strictEqual((tree[0] as FolderItem).folderName, 'src/components');
        assert.strictEqual((tree[0] as FolderItem).children.length, 1);
        assert.ok((tree[0] as FolderItem).children[0] instanceof FileChangeItem);
    });

    test('does not compact folder with multiple children', () => {
        const tree = buildFileTree([
            makeChange('/src/index.ts'),
            makeChange('/src/components/Button.tsx'),
        ]);
        assert.strictEqual(tree.length, 1);
        const src = tree[0] as FolderItem;
        assert.strictEqual(src.folderName, 'src');
        // src has index.ts + components folder = 2 children
        assert.strictEqual(src.children.length, 2);
    });

    test('nested folder structure', () => {
        const tree = buildFileTree([
            makeChange('/src/components/Button.tsx', VersionControlChangeType.Edit),
            makeChange('/src/components/Modal.tsx', VersionControlChangeType.Add),
            makeChange('/tests/Button.test.tsx', VersionControlChangeType.Add),
        ]);
        assert.strictEqual(tree.length, 2); // src/components + tests
    });

    test('preserves change type on file items', () => {
        const tree = buildFileTree([
            makeChange('/file.ts', VersionControlChangeType.Delete),
        ]);
        assert.ok(tree[0] instanceof FileChangeItem);
        assert.strictEqual((tree[0] as FileChangeItem).changeType, VersionControlChangeType.Delete);
    });

    test('handles paths without leading slash', () => {
        const tree = buildFileTree([
            { item: { path: 'src/foo.ts' }, changeType: VersionControlChangeType.Edit } as any,
        ]);
        assert.strictEqual(tree.length, 1);
        assert.ok(tree[0] instanceof FolderItem);
    });

    test('handles missing item path gracefully', () => {
        const tree = buildFileTree([
            { item: {} } as any,
            {} as any,
        ]);
        assert.strictEqual(tree.length, 0);
    });
});

suite('ActivePrRootItem', () => {
    test('shows PR title and number', () => {
        const item = new ActivePrRootItem({
            pullRequestId: 42,
            title: 'My PR',
            isDraft: false,
        } as any);
        assert.strictEqual(item.label, 'My PR');
        assert.strictEqual(item.description, '#42');
        assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    });

    test('uses draft icon for draft PRs', () => {
        const item = new ActivePrRootItem({ pullRequestId: 1, title: 'Draft', isDraft: true } as any);
        assert.ok(item.iconPath instanceof vscode.ThemeIcon);
        assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'git-pull-request-draft');
    });

    test('has click command to open detail', () => {
        const pr = { pullRequestId: 42, title: 'T', isDraft: false } as any;
        const item = new ActivePrRootItem(pr);
        assert.ok(item.command);
        assert.strictEqual(item.command.command, 'vscode-pr-azdo.openPullRequest');
    });
});

suite('SectionHeaderItem', () => {
    test('files section', () => {
        const item = new SectionHeaderItem('files', 'Files', 5);
        assert.strictEqual(item.label, 'Files');
        assert.strictEqual(item.description, '5');
        assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
        assert.ok(item.iconPath instanceof vscode.ThemeIcon);
        assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'files');
    });

    test('commits section', () => {
        const item = new SectionHeaderItem('commits', 'Commits', 3);
        assert.ok(item.iconPath instanceof vscode.ThemeIcon);
        assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'git-commit');
    });
});

suite('CommitItem', () => {
    test('shows short SHA and first line of message', () => {
        const item = new CommitItem({
            commitId: 'abcdef1234567890',
            comment: 'Fix the thing\n\nDetailed explanation',
            author: { name: 'Alice' },
        } as any);
        assert.strictEqual(item.label, 'Fix the thing');
        assert.strictEqual(item.description, 'abcdef1');
    });

    test('handles missing message', () => {
        const item = new CommitItem({ commitId: 'abc' } as any);
        assert.strictEqual(item.label, '(no message)');
    });
});

suite('FolderItem', () => {
    test('is collapsible', () => {
        const item = new FolderItem('src');
        assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
        assert.deepStrictEqual(item.children, []);
    });
});

suite('FileChangeItem', () => {
    test('shows file name and change type', () => {
        const item = new FileChangeItem('foo.ts', 'src/foo.ts', VersionControlChangeType.Edit);
        assert.strictEqual(item.label, 'foo.ts');
        assert.strictEqual(item.description, 'Edit');
        assert.strictEqual(item.filePath, 'src/foo.ts');
    });
});
