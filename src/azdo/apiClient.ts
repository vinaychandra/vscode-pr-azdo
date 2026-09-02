import * as vscode from 'vscode';
import * as azdev from 'azure-devops-node-api';
import type { IGitApi } from 'azure-devops-node-api/GitApi';
import type { ICoreApi } from 'azure-devops-node-api/CoreApi';
import type { ConnectionData } from 'azure-devops-node-api/interfaces/LocationsInterfaces';
import type { IAuthProvider } from './auth/iAuthProvider';
import type { AzDoRemoteInfo } from './remoteInfo';
import { discoverOrgTenantId } from './auth/tenantDiscovery';

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
        private readonly remoteInfo: AzDoRemoteInfo,
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
    private async getConnection(): Promise<azdev.WebApi> {
        if (this._connection) {
            return this._connection;
        }
        // If another caller already started connecting, piggyback on that promise
        if (this._connectingPromise) {
            return this._connectingPromise;
        }
        this._connectingPromise = this.doConnect();
        try {
            return await this._connectingPromise;
        } finally {
            this._connectingPromise = undefined;
        }
    }

    /** Internal connection logic — only one instance runs at a time. */
    private async doConnect(): Promise<azdev.WebApi> {

        this.log.appendLine('[api] Acquiring token for new connection…');
        const token = await this.authProvider.getToken({ tenantId: this._tenantId });
        if (!token) {
            throw new Error('Authentication required. Please sign in first.');
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
                return this.retryWithTenantDiscovery();
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
    private async retryWithTenantDiscovery(): Promise<azdev.WebApi> {
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
            forceNew: true,
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
    async getCurrentUserId(): Promise<string> {
        if (this._connectionData?.authenticatedUser?.id) {
            return this._connectionData.authenticatedUser.id;
        }

        const conn = await this.getConnection();
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
        if (this._connection) { return true; }

        this.log.appendLine('[api] Attempting silent connection…');
        const token = await this.authProvider.getToken({ silent: true, tenantId: this._tenantId });
        if (!token) {
            this.log.appendLine('[api] No cached token available (silent mode).');
            return false;
        }

        const handler = azdev.getBearerHandler(token);
        const conn = new azdev.WebApi(this.remoteInfo.apiBaseUrl, handler);

        try {
            this._connectionData = await conn.connect();
        } catch (err: unknown) {
            if (isAuthError(err)) {
                this.log.appendLine('[api] Silent connection failed (auth error) — skipping tenant discovery in silent mode.');
                return false;
            }
            throw err;
        }

        this._connection = conn;
        this.log.appendLine('[api] Silent connection established.');
        return true;
    }

    /** Run an API operation, silently reconnecting and retrying once on an auth failure. */
    async withAuthRecovery<T>(operation: () => Promise<T>): Promise<T> {
        const connectionAtStart = this._connection;
        try {
            return await operation();
        } catch (err) {
            if (!isAuthError(err)) {
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
            return operation();
        }
    }

    private async recoverSilently(failedConnection: azdev.WebApi | undefined): Promise<boolean> {
        if (this._connection && this._connection !== failedConnection) {
            return true;
        }
        if (this._authRecoveryPromise) {
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
    const msg = String(err);
    // Standard HTTP codes
    if (/\b(401|403|unauthorized|forbidden)\b/i.test(msg)) { return true; }
    // Azure DevOps-specific: "TF400813: The user '…' is not authorized to access this resource."
    if (/TF400813/i.test(msg)) { return true; }
    if (/\bnot authorized\b/i.test(msg)) { return true; }
    return false;
}
