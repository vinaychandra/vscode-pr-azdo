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

    test('returns snapshot mode without prompting', async () => {
        const mode = await chooseCheckoutMode('snapshot', async () => {
            assert.fail('explicit snapshot mode should not prompt');
        });

        assert.strictEqual(mode, 'snapshot');
    });

    test('returns the mode selected for this checkout', async () => {
        const mode = await chooseCheckoutMode(undefined, async items => {
            assert.deepStrictEqual(items, CHECKOUT_MODE_ITEMS);
            return items.find(item => item.mode === 'branch');
        });

        assert.strictEqual(mode, 'branch');
    });

    test('offers review without checkout before checkout destinations', () => {
        assert.strictEqual(CHECKOUT_MODE_ITEMS[0].mode, 'snapshot');
        assert.match(CHECKOUT_MODE_ITEMS[0].label, /Without Checkout/);
    });

    test('returns undefined when checkout selection is cancelled', async () => {
        assert.strictEqual(await chooseCheckoutMode(undefined, async () => undefined), undefined);
    });
});