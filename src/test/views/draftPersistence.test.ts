import * as assert from 'assert';
import * as vscode from 'vscode';
import { DraftPersistenceManager } from '../../views/draftPersistence';
import type { PersistedDrafts } from '../../views/prCommentController';

function createMockLog(): vscode.OutputChannel {
    return { appendLine: () => { } } as unknown as vscode.OutputChannel;
}

suite('DraftPersistenceManager', () => {
    test('flush persists pending snapshots for each PR', async () => {
        const saved = new Map<string, PersistedDrafts>();
        const workspaceState = {
            update: async (key: string, value: PersistedDrafts) => { saved.set(key, value); },
        } as unknown as vscode.Memento;
        const snapshots = new Map<number, PersistedDrafts>([
            [1, { aiDrafts: [{ filePath: 'one.ts', line: 1, body: 'one' }], userDrafts: [], replyDrafts: [] }],
            [2, { aiDrafts: [], userDrafts: [], replyDrafts: [] }],
        ]);
        const manager = new DraftPersistenceManager(
            workspaceState,
            'draftComments',
            prId => snapshots.get(prId)!,
            createMockLog(),
        );

        manager.schedule(1);
        manager.schedule(2);
        await manager.flush();

        assert.deepStrictEqual(saved.get('draftComments-1'), snapshots.get(1));
        assert.deepStrictEqual(saved.get('draftComments-2'), snapshots.get(2));
        manager.dispose();
    });

    test('rescheduling one PR keeps another PR pending', async () => {
        const savedKeys: string[] = [];
        const workspaceState = {
            update: async (key: string) => { savedKeys.push(key); },
        } as unknown as vscode.Memento;
        const manager = new DraftPersistenceManager(
            workspaceState,
            'draftComments',
            () => ({ aiDrafts: [], userDrafts: [], replyDrafts: [] }),
            createMockLog(),
        );

        manager.schedule(1);
        manager.schedule(2);
        manager.schedule(1);
        await manager.flush();

        assert.deepStrictEqual(savedKeys.sort(), ['draftComments-1', 'draftComments-2']);
        manager.dispose();
    });

    test('flush waits for a write that is already in flight', async () => {
        let finishWrite!: () => void;
        const writeFinished = new Promise<void>(resolve => { finishWrite = resolve; });
        const workspaceState = {
            update: async () => { await writeFinished; },
        } as unknown as vscode.Memento;
        const manager = new DraftPersistenceManager(
            workspaceState,
            'draftComments',
            () => ({ aiDrafts: [], userDrafts: [], replyDrafts: [] }),
            createMockLog(),
            0,
        );

        manager.schedule(1);
        await new Promise(resolve => setTimeout(resolve, 0));
        let flushed = false;
        const flushing = manager.flush().then(() => { flushed = true; });
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.strictEqual(flushed, false);

        finishWrite();
        await flushing;
        assert.strictEqual(flushed, true);
        manager.dispose();
    });
});