import * as vscode from 'vscode';
import type { IAuthProvider } from './iAuthProvider';

/** Azure DevOps resource application ID — used as the OAuth scope. */
const AZDO_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';
const SCOPES = [`${AZDO_RESOURCE_ID}/.default`];

/**
 * Microsoft Entra ID authentication provider.
 *
 * Uses VS Code's built-in Microsoft authentication extension to obtain
 * bearer tokens scoped to Azure DevOps.
 */
export class EntraIdAuthProvider implements IAuthProvider {
    readonly providerId = 'entra-id';

    private readonly _disposables: vscode.Disposable[] = [];

    constructor(private readonly log: vscode.OutputChannel) {
        this._disposables.push(
            vscode.authentication.onDidChangeSessions(e => {
                if (e.provider.id === 'microsoft') {
                    this.log.appendLine(
                        `[auth:entra] Microsoft auth sessions changed (added=${e.provider.id})`,
                    );
                }
            }),
        );
        this.log.appendLine('[auth:entra] EntraIdAuthProvider created.');
    }

    async getToken(options?: { silent?: boolean }): Promise<string | undefined> {
        const silent = options?.silent ?? false;
        this.log.appendLine(`[auth:entra] getToken called (silent=${silent})`);

        try {
            // First try silent — no user prompt
            let session = await vscode.authentication.getSession('microsoft', SCOPES, {
                silent: true,
            });

            if (session) {
                this.log.appendLine(
                    `[auth:entra] Reused existing session for account: ${session.account.label}`,
                );
                return session.accessToken;
            }

            if (silent) {
                this.log.appendLine('[auth:entra] No session available (silent mode).');
                return undefined;
            }

            // Prompt the user
            this.log.appendLine('[auth:entra] No cached session — prompting user…');
            session = await vscode.authentication.getSession('microsoft', SCOPES, {
                createIfNone: true,
            });

            if (session) {
                this.log.appendLine(
                    `[auth:entra] Authenticated as: ${session.account.label}`,
                );
                return session.accessToken;
            }

            this.log.appendLine('[auth:entra] User cancelled authentication.');
            return undefined;
        } catch (err) {
            this.log.appendLine(`[auth:entra] Authentication error: ${err}`);
            return undefined;
        }
    }

    async isAuthenticated(): Promise<boolean> {
        const token = await this.getToken({ silent: true });
        return token !== undefined;
    }

    dispose(): void {
        for (const d of this._disposables) {
            d.dispose();
        }
    }
}
