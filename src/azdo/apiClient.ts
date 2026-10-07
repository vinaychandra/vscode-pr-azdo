import * as vscode from 'vscode';
import * as azdev from 'azure-devops-node-api';
import type { IGitApi } from 'azure-devops-node-api/GitApi';
import type { ICoreApi } from 'azure-devops-node-api/CoreApi';
import type { ConnectionData } from 'azure-devops-node-api/interfaces/LocationsInterfaces';
import type { IAuthProvider } from './auth/iAuthProvider';
import type { ParsedAzDoRemote } from './remoteInfo';
import { discoverOrgTenantId } from './auth/tenantDiscovery';

export class AuthenticationRequiredError extends Error {
    constructor() {
        super('Authentication required. Please sign in first.');
        this.name = 'AuthenticationRequiredError';
    }
}

/** Error subclass surfaced when the current token cannot access the target org. */
export class TenantMismatchError extends Error {
    constructor(
        public readonly organization: string,
        public readonly discoveredTenantId: string | undefined,
    ) {
        super(
            discoveredTenantId
                ? `Authentication failed for organization "${organization}". ` +
                `The organization belongs to tenant ${discoveredTenantId}, ` +
                `but the current session does not have access.`
                : `Authentication failed for organization "${organization}". ` +
                `The current session may not have access to this organization's tenant.`,
        );
        this.name = 'TenantMismatchError';
    }
}

/**
 * Central connection manager for Azure DevOps APIs.
 *
 * Lazily creates a `WebApi` connection on first use and exposes typed
 * API clients. Accepts any `IAuthProvider` — the auth strategy is
 * pluggable.
 *
 * When the initial connection fails with a 401/403 (common in multi-tenant
 * scenarios), the client automatically discovers the org's Entra tenant ID
 * and retries authentication with a tenant-specific scope.
 */
export class AzDoApiClient implements vscode.Disposable {
    private _connection: azdev.WebApi | undefined;
    private _connectionData: ConnectionData | undefined;
    /** Cached tenant ID discovered for the current org (persisted via extension). */
    private _tenantId: string | undefined;
    /** Mutex: if a connection attempt is in-flight, subsequent callers await it. */
    private _connectingPromise: Promise<azdev.WebApi> | undefined;
    /** Shared silent recovery attempt for concurrent API authorization failures. */
    private _authRecoveryPromise: Promise<boolean> | undefined;

    constructor(
        private readonly authProvider: IAuthProvider,
        private readonly remoteInfo: ParsedAzDoRemote,
        private readonly log: vscode.OutputChannel,
        private readonly tenantCache?: {
            get(org: string): string | undefined;
            set(org: string, tenantId: string): void;
        },
    ) {
        this.log.appendLine(
            `[api] AzDoApiClient created for ${remoteInfo.apiBaseUrl} (auth: ${authProvider.providerId})`,
        );
        // Pre-load cached tenant if available
        this._tenantId = tenantCache?.get(remoteInfo.organization);
        if (this._tenantId) {
            this.log.appendLine(`[api] Using cached tenant: ${this._tenantId}`);
        }
    }

    /** Get (or create) the underlying WebApi connection. */
    private async getConnection(interactive = false): Promise<azdev.WebApi> {
        if (this._connection) {
            return this._connection;
        }
        if (this._authRecoveryPromise) {
            if (await this._authRecoveryPromise && this._connection) {
                return this._connection;
            }
            if (!interactive) { throw new AuthenticationRequiredError(); }
        }
        // If another caller already started connecting, piggyback on that promise
        if (this._connectingPromise) {
            try {
                return await this._connectingPromise;
            } catch (error) {
                if (!interactive || !isAuthError(error)) { throw error; }
            }
        }
        this._connectingPromise = this.doConnect(interactive);
        try {
            return await this._connectingPromise;
        } finally {
            this._connectingPromise = undefined;
        }
    }

    /** Internal connection logic — only one instance runs at a time. */
    private async doConnect(interactive: boolean): Promise<azdev.WebApi> {

        this.log.appendLine('[api] Acquiring token for new connection…');
        const token = await this.authProvider.getToken({ tenantId: this._tenantId, silent: !interactive });
        if (!token) {
            throw new AuthenticationRequiredError();
        }

        this.log.appendLine('[api] Creating WebApi connection…');
        const handler = azdev.getBearerHandler(token);
        const conn = new azdev.WebApi(this.remoteInfo.apiBaseUrl, handler);

        // Validate by calling connect() — this verifies the token works for this org
        try {
            this.log.appendLine('[api] Validating connection…');
            this._connectionData = await conn.connect();
            this.log.appendLine('[api] Connection validated successfully.');
        } catch (err: unknown) {
            // Detect auth failures (401/403 — typical of wrong-tenant tokens)
            if (isAuthError(err)) {
                this.log.appendLine(
                    `[api] Connection validation failed (auth error) — attempting tenant discovery…`,
                );
                return this.retryWithTenantDiscovery(interactive);
            }
            throw err;
        }

        this._connection = conn;
        this.log.appendLine('[api] WebApi connection established.');
        return this._connection;
    }

    /**
     * Discover the org's tenant, get a tenant-scoped token, and retry.
     * Called at most once per connection attempt.
     */
    private async retryWithTenantDiscovery(interactive: boolean): Promise<azdev.WebApi> {
        const tenantId = await discoverOrgTenantId(
            this.remoteInfo.apiBaseUrl,
            this.log,
        );

        if (!tenantId) {
            throw new TenantMismatchError(this.remoteInfo.organization, undefined);
        }

        // Cache the discovered tenant
        this._tenantId = tenantId;
        this.tenantCache?.set(this.remoteInfo.organization, tenantId);

        this.log.appendLine(
            `[api] Retrying authentication with tenant ${tenantId}…`,
        );
        const token = await this.authProvider.getToken({
            tenantId,
            silent: !interactive,
        });
        if (!token) {
            throw new TenantMismatchError(this.remoteInfo.organization, tenantId);
        }

        const handler = azdev.getBearerHandler(token);
        const conn = new azdev.WebApi(this.remoteInfo.apiBaseUrl, handler);

        // Validate again — if this also fails, surface as TenantMismatchError
        try {
            this._connectionData = await conn.connect();
        } catch (retryErr: unknown) {
            if (isAuthError(retryErr)) {
                throw new TenantMismatchError(this.remoteInfo.organization, tenantId);
            }
            throw retryErr;
        }

        this._connection = conn;
        this.log.appendLine('[api] Tenant-specific connection established.');
        return this._connection;
    }

    /**
     * Get the authenticated user's identity ID.
     * Cached after the first call.
     */
    async getCurrentUserId(interactive = false): Promise<string> {
        if (this._connectionData?.authenticatedUser?.id) {
            return this._connectionData.authenticatedUser.id;
        }

        const conn = await this.getConnection(interactive);
        // Connection data is already populated by getConnection()'s validate step,
        // but defensively re-fetch if somehow missing.
        if (!this._connectionData) {
            this.log.appendLine('[api] Fetching connection data for current user…');
            this._connectionData = await conn.connect();
        }
        const userId = this._connectionData.authenticatedUser?.id;
        if (!userId) {
            throw new Error('Could not determine authenticated user identity.');
        }
        this.log.appendLine(
            `[api] Authenticated user: ${this._connectionData.authenticatedUser?.customDisplayName ?? '(unknown)'} (id: ${userId})`,
        );
        return userId;
    }

    /** Whether the client currently holds a validated connection. */
    get isConnected(): boolean {
        return !!this._connection;
    }

    /**
     * Attempt to establish a connection using only a cached/silent token.
     * Never shows a login prompt. Returns `true` if a connection was
     * established, `false` if no valid token is available.
     */
    async tryConnectSilently(): Promise<boolean> {
        this.log.appendLine('[api] Attempting silent connection…');
        try {
            await this.getConnection();
        } catch (err: unknown) {
            if (isAuthError(err)) {
                this.log.appendLine('[api] Silent connection unavailable — sign-in remains a user action.');
                return false;
            }
            throw err;
        }

        this.log.appendLine('[api] Silent connection established.');
        return true;
    }

    /** Run an API operation, silently reconnecting and retrying once on an auth failure. */
    async withAuthRecovery<T>(operation: () => Promise<T>): Promise<T> {
        const connectionAtStart = this._connection;
        try {
            return await operation();
        } catch (err) {
            if (err instanceof AuthenticationRequiredError || !isAuthError(err)) {
                throw err;
            }

            this.log.appendLine('[api] API authorization failed — attempting silent recovery.');
            const failedConnection = connectionAtStart ?? this._connection;
            const recovered = await this.recoverSilently(failedConnection);
            if (!recovered) {
                this.log.appendLine('[api] Silent recovery unavailable.');
                throw err;
            }

            this.log.appendLine('[api] Silent recovery succeeded — retrying API operation.');
            try {
                return await operation();
            } catch (retryErr) {
                const category = isAuthError(retryErr) ? 'authorization' : 'non-auth';
                this.log.appendLine(`[api] Retried API operation failed (${category} error).`);
                throw retryErr;
            }
        }
    }

    private async recoverSilently(failedConnection: azdev.WebApi | undefined): Promise<boolean> {
        if (this._connection && this._connection !== failedConnection) {
            this.log.appendLine('[api] Reusing connection refreshed by another request.');
            return true;
        }
        if (this._authRecoveryPromise) {
            this.log.appendLine('[api] Waiting for in-flight silent recovery.');
            return this._authRecoveryPromise;
        }

        this.resetConnection();
        const recovery = this.tryConnectSilently();
        this._authRecoveryPromise = recovery;
        try {
            return await recovery;
        } finally {
            if (this._authRecoveryPromise === recovery) {
                this._authRecoveryPromise = undefined;
            }
        }
    }

    /**
     * Invalidate the cached connection so the next call re-authenticates.
     * Useful after a 401 or when the user signs out.
     */
    resetConnection(): void {
        this._connection = undefined;
        this._connectionData = undefined;
        this.log.appendLine('[api] Connection reset — will re-authenticate on next call.');
    }

    async getGitApi(): Promise<IGitApi> {
        const conn = await this.getConnection();
        return conn.getGitApi();
    }

    async getCoreApi(): Promise<ICoreApi> {
        const conn = await this.getConnection();
        return conn.getCoreApi();
    }

    dispose(): void {
        this._connection = undefined;
        this._connectionData = undefined;
    }
}

/** Check whether an error looks like an auth/authorization failure. */
export function isAuthError(err: unknown): boolean {
    if (!err) { return false; }
    if (err instanceof AuthenticationRequiredError || err instanceof TenantMismatchError) { return true; }
    if (typeof err === 'object') {
        const status = (err as { statusCode?: unknown; status?: unknown }).statusCode
            ?? (err as { status?: unknown }).status;
        if (status === 401 || status === 403) { return true; }
    }
    const msg = String(err);
    // Standard HTTP codes
    if (/\b(401|403|unauthorized|forbidden)\b/i.test(msg)) { return true; }
    // Azure DevOps-specific: "TF400813: The user '…' is not authorized to access this resource."
    if (/TF400813/i.test(msg)) { return true; }
    if (/\bnot authorized\b/i.test(msg)) { return true; }
    return false;
}
