import * as assert from 'assert';
import { CHECKOUT_MODE_ITEMS, chooseCheckoutMode } from '../../views/checkoutMode';

suite('chooseCheckoutMode', () => {
    test('returns an explicit mode without prompting', async () => {
        let prompted = false;

        const mode = await chooseCheckoutMode('worktree', async () => {
            prompted = true;
            return undefined;
        });

        assert.strictEqual(mode, 'worktree');
        assert.strictEqual(prompted, false);
    });

    test('returns the mode selected for this checkout', async () => {
        const mode = await chooseCheckoutMode(undefined, async items => {
            assert.deepStrictEqual(items, CHECKOUT_MODE_ITEMS);
            return items.find(item => item.mode === 'branch');
        });

        assert.strictEqual(mode, 'branch');
    });

    test('returns undefined when checkout selection is cancelled', async () => {
        assert.strictEqual(await chooseCheckoutMode(undefined, async () => undefined), undefined);
    });
});