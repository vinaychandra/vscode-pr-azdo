import { Disposable } from 'vscode';

/** Options accepted by {@link IAuthProvider.getToken}. */
export interface GetTokenOptions {
    /** If `true`, never prompt the user — return `undefined` if no token can be obtained silently. */
    silent?: boolean;
    /**
     * Target a specific Entra tenant when acquiring the token.
     * When set, VS Code's Microsoft auth will authenticate against this
     * tenant instead of the default "organizations" endpoint.
     */
    tenantId?: string;
    /**
     * Force a brand-new session even if one is cached.
     * Used when the current session failed against the target AzDO org.
     */
    forceNew?: boolean;
}

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
     * @param options Controls prompting, tenant targeting, and session reuse.
     * @returns An access token string, or `undefined` if unavailable.
     */
    getToken(options?: GetTokenOptions): Promise<string | undefined>;

    /** Check whether a token can be obtained without prompting the user. */
    isAuthenticated(): Promise<boolean>;
}
