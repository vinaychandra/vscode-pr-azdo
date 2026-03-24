import * as vscode from 'vscode';
import type { IAuthProvider, GetTokenOptions } from './iAuthProvider';

/** Azure DevOps resource application ID — used as the OAuth scope. */
const AZDO_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';
const BASE_SCOPES = [`${AZDO_RESOURCE_ID}/.default`];

/** Build scopes array, optionally targeting a specific Entra tenant. */
function buildScopes(tenantId?: string): string[] {
    if (tenantId) {
        return [...BASE_SCOPES, `VSCODE_TENANT:${tenantId}`];
    }
    return BASE_SCOPES;
}

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

    async getToken(options?: GetTokenOptions): Promise<string | undefined> {
        const silent = options?.silent ?? false;
        const tenantId = options?.tenantId;
        const forceNew = options?.forceNew ?? false;
        const scopes = buildScopes(tenantId);

        this.log.appendLine(
            `[auth:entra] getToken called (silent=${silent}, tenant=${tenantId ?? 'default'}, forceNew=${forceNew})`,
        );

        try {
            // If caller requested a forced new session (e.g. after tenant mismatch),
            // skip the silent path and go straight to interactive with forceNewSession.
            if (forceNew) {
                this.log.appendLine('[auth:entra] Forcing new session…');
                const session = await vscode.authentication.getSession('microsoft', scopes, {
                    forceNewSession: {
                        detail: tenantId
                            ? `The current session does not have access to this Azure DevOps organization. Re-authenticating against tenant ${tenantId}.`
                            : 'Re-authenticating to Azure DevOps.',
                    },
                    clearSessionPreference: true,
                });
                if (session) {
                    this.log.appendLine(
                        `[auth:entra] Forced new session for account: ${session.account.label}`,
                    );
                    return session.accessToken;
                }
                this.log.appendLine('[auth:entra] User cancelled forced re-authentication.');
                return undefined;
            }

            // First try silent — no user prompt
            let session = await vscode.authentication.getSession('microsoft', scopes, {
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
            session = await vscode.authentication.getSession('microsoft', scopes, {
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
