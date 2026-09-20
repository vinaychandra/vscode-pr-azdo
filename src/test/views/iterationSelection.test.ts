import * as assert from 'assert';
import { iterationRangeDescription, iterationSelectionEntries, resolveIterationRange, selectedIterationIds } from '../../views/iterationSelection';

suite('iterationSelection', () => {
    const available = [1, 2, 3, 4, 5];

    test('maps one iteration to the preceding Azure iteration', () => {
        assert.deepStrictEqual(resolveIterationRange(available, [3]), {
            iterationId: 3,
            compareToIterationId: 2,
            selectedIterationIds: [3],
        });
    });

    test('maps iteration one to Azure common-base comparison zero', () => {
        assert.deepStrictEqual(resolveIterationRange(available, [1]), {
            iterationId: 1,
            compareToIterationId: 0,
            selectedIterationIds: [1],
        });
    });

    test('maps a contiguous range to its upper and preceding endpoints', () => {
        assert.deepStrictEqual(resolveIterationRange(available, [2, 3, 4]), {
            iterationId: 4,
            compareToIterationId: 1,
            selectedIterationIds: [2, 3, 4],
        });
    });

    test('fills gaps and defaults an empty selection to latest', () => {
        assert.deepStrictEqual(resolveIterationRange(available, [1, 3])?.selectedIterationIds, [1, 2, 3]);
        assert.deepStrictEqual(resolveIterationRange(available, [])?.selectedIterationIds, [5]);
    });

    test('reconstructs selected IDs and labels', () => {
        const selected = selectedIterationIds(available, 4, 1);
        assert.deepStrictEqual(selected, [2, 3, 4]);
        assert.strictEqual(iterationRangeDescription(resolveIterationRange(available, selected)!, 5), 'Iterations 2-4');
        assert.strictEqual(iterationRangeDescription(resolveIterationRange(available, available)!, 5), 'Full pull request');
        assert.deepStrictEqual(selectedIterationIds(available, 4, 99), []);
    });

    test('orders latest first and base last', () => {
        assert.deepStrictEqual(iterationSelectionEntries([1, 3, 2]), [
            { kind: 'iteration', iterationId: 3, latest: true },
            { kind: 'iteration', iterationId: 2, latest: false },
            { kind: 'iteration', iterationId: 1, latest: false },
            { kind: 'base' },
        ]);
    });
});