import { Disposable } from 'vscode';

/**
 * Extensible authentication provider contract.
 *
 * Implementations supply access tokens for Azure DevOps API calls.
 * New auth methods (PAT, service principal, etc.) can be added by
 * implementing this interface.
 */
export interface IAuthProvider extends Disposable {
    /** Unique identifier for this provider (e.g. 'entra-id', 'pat'). */
    readonly providerId: string;

    /**
     * Acquire a valid access token.
     *
     * @param options.silent If `true`, never prompt the user — return
     *   `undefined` if no token can be obtained silently.
     * @returns An access token string, or `undefined` if unavailable.
     */
    getToken(options?: { silent?: boolean }): Promise<string | undefined>;

    /** Check whether a token can be obtained without prompting the user. */
    isAuthenticated(): Promise<boolean>;
}
