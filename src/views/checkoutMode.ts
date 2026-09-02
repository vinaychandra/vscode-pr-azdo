import * as vscode from 'vscode';

export type CheckoutMode = 'branch' | 'worktree' | 'snapshot';

export interface CheckoutModeQuickPickItem extends vscode.QuickPickItem {
    mode: CheckoutMode;
}

export const CHECKOUT_MODE_ITEMS: readonly CheckoutModeQuickPickItem[] = [
    {
        label: '$(git-compare) Review Without Checkout',
        description: 'Review the PR snapshot without changing local files or branches',
        mode: 'snapshot',
    },
    {
        label: '$(git-branch) Current Repository',
        description: 'Check out the PR source branch in this repository',
        mode: 'branch',
    },
    {
        label: '$(repo) Review Worktree',
        description: 'Open the PR source commit in the reusable detached worktree',
        mode: 'worktree',
    },
];

type ShowCheckoutModeQuickPick = (
    items: readonly CheckoutModeQuickPickItem[],
    options: vscode.QuickPickOptions,
) => Thenable<CheckoutModeQuickPickItem | undefined>;

export async function chooseCheckoutMode(
    requestedMode: unknown,
    showQuickPick: ShowCheckoutModeQuickPick = (items, options) => vscode.window.showQuickPick(items, options),
): Promise<CheckoutMode | undefined> {
    if (requestedMode === 'branch' || requestedMode === 'worktree' || requestedMode === 'snapshot') {
        return requestedMode;
    }
    const selected = await showQuickPick(CHECKOUT_MODE_ITEMS, {
        placeHolder: 'How should this pull request be reviewed?',
        title: 'Review Pull Request',
    });
    return selected?.mode;
}