import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BUILT_IN_REVIEW_LENSES, ReviewLensService, validateReviewLensName } from '../../chat/reviewLenses';

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

suite('ReviewLensService', () => {
    const cleanup: string[] = [];

    teardown(() => {
        for (const root of cleanup.splice(0)) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    function createService(): { service: ReviewLensService; lensFolder: string } {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'azdo-review-lenses-'));
        cleanup.push(root);
        const state = new Map<string, unknown>();
        const context = {
            globalStorageUri: vscode.Uri.file(root),
            globalState: {
                get: <T>(key: string, defaultValue?: T) => state.has(key) ? state.get(key) as T : defaultValue,
                update: async (key: string, value: unknown) => { state.set(key, value); },
                keys: () => [...state.keys()],
                setKeysForSync: () => { },
            },
        } as unknown as vscode.ExtensionContext;
        return {
            service: new ReviewLensService(context, createMockLog()),
            lensFolder: path.join(root, 'review-lenses'),
        };
    }

    test('lists built-ins before alphabetized custom Markdown lenses', async () => {
        const { service, lensFolder } = createService();
        await service.initialize();
        fs.writeFileSync(path.join(lensFolder, 'Reliability.md'), 'Focus on retries.');
        fs.writeFileSync(path.join(lensFolder, 'API Contracts.md'), 'Focus on compatibility.');
        fs.writeFileSync(path.join(lensFolder, 'ignored.txt'), 'Not a lens.');

        const lenses = await service.listLenses();

        assert.deepStrictEqual(
            lenses.slice(0, BUILT_IN_REVIEW_LENSES.length).map(lens => lens.id),
            BUILT_IN_REVIEW_LENSES.map(lens => lens.id),
        );
        assert.deepStrictEqual(
            lenses.slice(BUILT_IN_REVIEW_LENSES.length).map(lens => lens.name),
            ['API Contracts', 'Reliability'],
        );
    });

    test('resolves custom lens content by stable file ID', async () => {
        const { service, lensFolder } = createService();
        await service.initialize();
        fs.writeFileSync(path.join(lensFolder, 'Reliability.md'), 'Focus on retries and idempotency.');

        const lens = await service.resolveLens('custom:Reliability.md');

        assert.strictEqual(lens?.name, 'Reliability');
        assert.strictEqual(lens?.prompt, 'Focus on retries and idempotency.');
        assert.strictEqual(lens?.builtIn, false);
    });

    test('rejects missing, empty, and unsafe custom lens files', async () => {
        const { service, lensFolder } = createService();
        await service.initialize();
        fs.writeFileSync(path.join(lensFolder, 'Empty.md'), '   ');

        assert.strictEqual(await service.resolveLens('custom:Empty.md'), undefined);
        assert.strictEqual(await service.resolveLens('custom:Missing.md'), undefined);
        assert.strictEqual(await service.resolveLens('custom:../outside.md'), undefined);
    });

    test('migrates the legacy review prompt without changing its content', async () => {
        const config = vscode.workspace.getConfiguration('vscode-pr-azdo.prompts');
        const previous = config.inspect<string>('review')?.globalValue;
        const legacy = 'Legacy custom review\nwith exact spacing.  ';
        const { service, lensFolder } = createService();
        try {
            await config.update('review', legacy, vscode.ConfigurationTarget.Global);

            await service.initialize();

            assert.strictEqual(fs.readFileSync(path.join(lensFolder, 'Migrated Review.md'), 'utf-8'), legacy);
            assert.strictEqual(config.inspect<string>('review')?.globalValue, undefined);
        } finally {
            await config.update('review', previous, vscode.ConfigurationTarget.Global);
        }
    });
});

suite('validateReviewLensName', () => {
    test('accepts a normal unique lens name', () => {
        assert.strictEqual(validateReviewLensName('Reliability', ['API Contracts']), undefined);
    });

    test('rejects built-in and custom duplicates case-insensitively', () => {
        assert.match(validateReviewLensName('security') ?? '', /already exists/);
        assert.match(validateReviewLensName('reliability', ['Reliability']) ?? '', /already exists/);
    });

    test('rejects traversal, invalid characters, and Windows reserved names', () => {
        assert.ok(validateReviewLensName('../unsafe'));
        assert.ok(validateReviewLensName('unsafe:name'));
        assert.ok(validateReviewLensName('CON'));
        assert.ok(validateReviewLensName('trailing.'));
    });
});