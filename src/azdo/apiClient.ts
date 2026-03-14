import * as vscode from 'vscode';
import * as azdev from 'azure-devops-node-api';
import type { IGitApi } from 'azure-devops-node-api/GitApi';
import type { ICoreApi } from 'azure-devops-node-api/CoreApi';
import type { ConnectionData } from 'azure-devops-node-api/interfaces/LocationsInterfaces';
import type { IAuthProvider } from './auth/iAuthProvider';
import type { AzDoRemoteInfo } from './remoteInfo';

/**
 * Central connection manager for Azure DevOps APIs.
 *
 * Lazily creates a `WebApi` connection on first use and exposes typed
 * API clients. Accepts any `IAuthProvider` — the auth strategy is
 * pluggable.
 */
export class AzDoApiClient implements vscode.Disposable {
    private _connection: azdev.WebApi | undefined;
    private _connectionData: ConnectionData | undefined;

    constructor(
        private readonly authProvider: IAuthProvider,
        private readonly remoteInfo: AzDoRemoteInfo,
        private readonly log: vscode.OutputChannel,
    ) {
        this.log.appendLine(
            `[api] AzDoApiClient created for ${remoteInfo.apiBaseUrl} (auth: ${authProvider.providerId})`,
        );
    }

    /** Get (or create) the underlying WebApi connection. */
    private async getConnection(): Promise<azdev.WebApi> {
        if (this._connection) {
            return this._connection;
        }

        this.log.appendLine('[api] Acquiring token for new connection…');
        const token = await this.authProvider.getToken();
        if (!token) {
            throw new Error('Authentication required. Please sign in first.');
        }

        this.log.appendLine('[api] Creating WebApi connection…');
        const handler = azdev.getBearerHandler(token);
        this._connection = new azdev.WebApi(this.remoteInfo.apiBaseUrl, handler);
        this.log.appendLine('[api] WebApi connection established.');
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
        this.log.appendLine('[api] Fetching connection data for current user…');
        this._connectionData = await conn.connect();
        const userId = this._connectionData.authenticatedUser?.id;
        if (!userId) {
            throw new Error('Could not determine authenticated user identity.');
        }
        this.log.appendLine(
            `[api] Authenticated user: ${this._connectionData.authenticatedUser?.customDisplayName ?? '(unknown)'} (id: ${userId})`,
        );
        return userId;
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
