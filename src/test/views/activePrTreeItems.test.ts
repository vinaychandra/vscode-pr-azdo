import * as assert from 'assert';
import {
    buildFileTree,
    changeTypeLabel,
    iconForChangeType,
    getChangePath,
    FolderItem,
    FileChangeItem,
    ActivePrRootItem,
    ReviewModeToggleItem,
    SectionHeaderItem,
    CommitItem,
    CommentThreadItem,
} from '../../views/activePrTreeItems';
import { VersionControlChangeType, CommentType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import type { GitPullRequestChange, GitCommitRef, GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
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

suite('iconForChangeType', () => {
    test('Delete uses diff-removed icon with deleted color', () => {
        const icon = iconForChangeType(VersionControlChangeType.Delete);
        assert.ok(icon instanceof vscode.ThemeIcon);
        assert.strictEqual(icon.id, 'diff-removed');
        assert.ok(icon.color instanceof vscode.ThemeColor);
    });

    test('Add uses diff-added icon with added color', () => {
        const icon = iconForChangeType(VersionControlChangeType.Add);
        assert.ok(icon instanceof vscode.ThemeIcon);
        assert.strictEqual(icon.id, 'diff-added');
        assert.ok(icon.color instanceof vscode.ThemeColor);
    });

    test('Rename uses diff-renamed icon', () => {
        const icon = iconForChangeType(VersionControlChangeType.Rename);
        assert.ok(icon instanceof vscode.ThemeIcon);
        assert.strictEqual(icon.id, 'diff-renamed');
    });

    test('Edit returns the default file icon (no color override)', () => {
        const icon = iconForChangeType(VersionControlChangeType.Edit);
        assert.strictEqual(icon, vscode.ThemeIcon.File);
    });

    test('combined Add|Edit bitmask prefers Add styling', () => {
        const icon = iconForChangeType(VersionControlChangeType.Add | VersionControlChangeType.Edit);
        assert.strictEqual((icon as vscode.ThemeIcon).id, 'diff-added');
    });
});

suite('FileChangeItem visuals', () => {
    test('deleted file uses the diff-removed icon', () => {
        const tree = buildFileTree([{ item: { path: '/gone.ts' }, changeType: VersionControlChangeType.Delete } as any]);
        const file = tree[0] as FileChangeItem;
        assert.ok(file instanceof FileChangeItem);
        assert.ok(file.iconPath instanceof vscode.ThemeIcon);
        assert.strictEqual((file.iconPath as vscode.ThemeIcon).id, 'diff-removed');
        assert.strictEqual(file.description, 'Delete');
    });

    test('edited file keeps the default file icon', () => {
        const tree = buildFileTree([{ item: { path: '/index.ts' }, changeType: VersionControlChangeType.Edit } as any]);
        const file = tree[0] as FileChangeItem;
        assert.strictEqual(file.iconPath, vscode.ThemeIcon.File);
    });
});

suite('getChangePath', () => {
    test('reads item.path for edited/added entries', () => {
        assert.strictEqual(
            getChangePath({ item: { path: '/src/index.ts' }, changeType: VersionControlChangeType.Edit } as any),
            'src/index.ts',
        );
    });

    test('reads originalPath for delete entries (item.path is null)', () => {
        // Real AzDO payload shape observed for deletes:
        // {"originalPath":"/File2","item":{"originalObjectId":"...","path":null},"changeType":16}
        assert.strictEqual(
            getChangePath({
                originalPath: '/File2',
                item: { path: null, originalObjectId: 'abc' },
                changeType: VersionControlChangeType.Delete,
            } as any),
            'File2',
        );
    });

    test('strips leading slash', () => {
        assert.strictEqual(getChangePath({ item: { path: '/a/b/c.ts' } } as any), 'a/b/c.ts');
        assert.strictEqual(getChangePath({ originalPath: '/x.ts', item: { path: null } } as any), 'x.ts');
    });

    test('returns undefined when both fields are missing', () => {
        assert.strictEqual(getChangePath({ item: {} } as any), undefined);
        assert.strictEqual(getChangePath({} as any), undefined);
        assert.strictEqual(getChangePath({ item: { path: null }, originalPath: null } as any), undefined);
    });

    test('prefers item.path over originalPath when both are present (rename: new path wins)', () => {
        assert.strictEqual(
            getChangePath({
                item: { path: '/new/name.ts' },
                originalPath: '/old/name.ts',
                changeType: VersionControlChangeType.Rename | VersionControlChangeType.Edit,
            } as any),
            'new/name.ts',
        );
    });
});

suite('buildFileTree — delete entry shape', () => {
    test('includes deleted files using originalPath', () => {
        // This is the exact shape AzDO returns for a delete entry.
        const tree = buildFileTree([{
            changeTrackingId: 1,
            originalPath: '/File2',
            changeId: 1,
            item: { originalObjectId: 'B4F8B3659348CE7EE18871B9C25AC0889A9E974C', path: null },
            changeType: VersionControlChangeType.Delete,
        } as any]);
        assert.strictEqual(tree.length, 1, 'tree should contain the deleted file');
        const file = tree[0] as FileChangeItem;
        assert.ok(file instanceof FileChangeItem);
        assert.strictEqual(file.fileName, 'File2');
        assert.strictEqual(file.filePath, 'File2');
        assert.strictEqual(file.changeType, VersionControlChangeType.Delete);
    });

    test('mixed edit + delete tree', () => {
        const tree = buildFileTree([
            { item: { path: '/src/index.ts' }, changeType: VersionControlChangeType.Edit } as any,
            { originalPath: '/src/gone.ts', item: { path: null }, changeType: VersionControlChangeType.Delete } as any,
        ]);
        // Both files share a "src" folder
        assert.strictEqual(tree.length, 1);
        const folder = tree[0] as FolderItem;
        assert.strictEqual(folder.folderName, 'src');
        assert.strictEqual(folder.children.length, 2);
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

suite('ReviewModeToggleItem', () => {
    test('shows "Enable Review" when review mode OFF', () => {
        const item = new ReviewModeToggleItem(false, 5);
        assert.strictEqual(item.label, 'Enable Review');
        assert.strictEqual(item.description, '5 threads');
        assert.ok(item.iconPath instanceof vscode.ThemeIcon);
        assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'eye-closed');
        assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
    });

    test('shows "Disable Review" when review mode ON', () => {
        const item = new ReviewModeToggleItem(true, 3);
        assert.strictEqual(item.label, 'Disable Review');
        assert.strictEqual(item.description, '3 threads');
        assert.ok(item.iconPath instanceof vscode.ThemeIcon);
        assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'eye');
    });

    test('singular thread label for 1 thread', () => {
        const item = new ReviewModeToggleItem(false, 1);
        assert.strictEqual(item.description, '1 thread');
    });

    test('empty description for 0 threads', () => {
        const item = new ReviewModeToggleItem(false, 0);
        assert.strictEqual(item.description, '');
    });

    test('has toggle review mode command', () => {
        const item = new ReviewModeToggleItem(false, 2);
        assert.ok(item.command);
        assert.strictEqual(item.command.command, 'vscode-pr-azdo.toggleReviewMode');
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

    test('starts as non-collapsible with no comments', () => {
        const item = new FileChangeItem('foo.ts', 'src/foo.ts', VersionControlChangeType.Edit);
        assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
        assert.strictEqual(item.commentThreads.length, 0);
    });

    test('becomes collapsible after adding comments and finalizing', () => {
        const item = new FileChangeItem('foo.ts', 'src/foo.ts', VersionControlChangeType.Edit);
        item.commentThreads.push(new CommentThreadItem({
            comments: [{ content: 'test', author: { displayName: 'A' } }],
        } as any));
        item.finalizeComments();
        assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    });
});

suite('CommentThreadItem', () => {
    function makeThread(overrides: Partial<GitPullRequestCommentThread> = {}): GitPullRequestCommentThread {
        return {
            comments: [
                { content: 'This looks wrong', author: { displayName: 'Alice' }, commentType: CommentType.Text, isDeleted: false },
            ],
            ...overrides,
        } as any;
    }

    test('shows first comment content and author', () => {
        const item = new CommentThreadItem(makeThread());
        assert.strictEqual(item.label, 'This looks wrong');
        assert.strictEqual(item.description, 'Alice');
    });

    test('truncates long content at 80 chars', () => {
        const longContent = 'A'.repeat(100);
        const item = new CommentThreadItem(makeThread({
            comments: [{ content: longContent, author: { displayName: 'Bob' }, commentType: CommentType.Text, isDeleted: false }],
        } as any));
        assert.ok((item.label as string).length <= 80);
        assert.ok((item.label as string).endsWith('…'));
    });

    test('skips system comments and shows first user comment', () => {
        const item = new CommentThreadItem(makeThread({
            comments: [
                { content: 'System msg', author: { displayName: 'System' }, commentType: CommentType.System, isDeleted: false },
                { content: 'User msg', author: { displayName: 'Carol' }, commentType: CommentType.Text, isDeleted: false },
            ],
        } as any));
        assert.strictEqual(item.label, 'User msg');
        assert.strictEqual(item.description, 'Carol');
    });

    test('skips deleted comments', () => {
        const item = new CommentThreadItem(makeThread({
            comments: [
                { content: 'Deleted', author: { displayName: 'X' }, commentType: CommentType.Text, isDeleted: true },
                { content: 'Visible', author: { displayName: 'Y' }, commentType: CommentType.Text, isDeleted: false },
            ],
        } as any));
        assert.strictEqual(item.label, 'Visible');
    });

    test('handles thread with no valid comments', () => {
        const item = new CommentThreadItem(makeThread({ comments: [] }));
        assert.strictEqual(item.label, '(no content)');
        assert.strictEqual(item.description, 'unknown');
    });

    test('uses comment icon', () => {
        const item = new CommentThreadItem(makeThread());
        assert.ok(item.iconPath instanceof vscode.ThemeIcon);
        assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'comment');
    });

    test('stores thread reference', () => {
        const thread = makeThread();
        const item = new CommentThreadItem(thread);
        assert.strictEqual(item.thread, thread);
    });
});
