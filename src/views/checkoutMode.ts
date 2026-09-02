import * as vscode from 'vscode';

export type CheckoutMode = 'branch' | 'worktree';

export interface CheckoutModeQuickPickItem extends vscode.QuickPickItem {
    mode: CheckoutMode;
}

export const CHECKOUT_MODE_ITEMS: readonly CheckoutModeQuickPickItem[] = [
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
    if (requestedMode === 'branch' || requestedMode === 'worktree') {
        return requestedMode;
    }
    const selected = await showQuickPick(CHECKOUT_MODE_ITEMS, {
        placeHolder: 'Where should this pull request be checked out?',
        title: 'Checkout Pull Request',
    });
    return selected?.mode;
}