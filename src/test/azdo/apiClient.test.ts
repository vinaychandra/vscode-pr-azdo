import * as assert from 'assert';
import * as http from 'http';
import { AzDoApiClient, TenantMismatchError, isAuthError } from '../../azdo/apiClient';
import type { IAuthProvider, GetTokenOptions } from '../../azdo/auth/iAuthProvider';
import type { AzDoRemoteInfo } from '../../azdo/remoteInfo';

/** Capture every getToken call for assertions. */
interface TokenCall {
    options: GetTokenOptions | undefined;
}

function createSpyAuthProvider(token: string | undefined = 'fake-token') {
    const calls: TokenCall[] = [];
    let tokenToReturn: string | undefined = token;
    const provider: IAuthProvider & { calls: TokenCall[]; setToken(t: string | undefined): void } = {
        providerId: 'test',
        calls,
        setToken(t: string | undefined) { tokenToReturn = t; },
        async getToken(options?: GetTokenOptions) {
            calls.push({ options });
            return tokenToReturn;
        },
        async isAuthenticated() { return tokenToReturn !== undefined; },
        dispose() { },
    };
    return provider;
}

function createRemoteInfo(org = 'myorg', baseUrl?: string): AzDoRemoteInfo {
    return {
        organization: org,
        project: 'myproject',
        repositoryName: 'myrepo',
        remoteName: 'origin',
        remoteUrl: `https://dev.azure.com/${org}/myproject/_git/myrepo`,
        apiBaseUrl: baseUrl ?? `https://dev.azure.com/${org}`,
        repository: {} as any,
    };
}

function createMockLog() {
    return {
        appendLine: () => { },
        append: () => { },
        clear: () => { },
        show: () => { },
        hide: () => { },
        dispose: () => { },
        replace: () => { },
        name: 'test',
    } as any;
}

suite('AzDoApiClient — isConnected', () => {
    test('starts as false', () => {
        const client = new AzDoApiClient(
            createSpyAuthProvider(),
            createRemoteInfo(),
            createMockLog(),
        );
        assert.strictEqual(client.isConnected, false);
        client.dispose();
    });

    test('is false after resetConnection', async () => {
        // We can't easily make it connected without a real WebApi,
        // but we can verify reset leaves it false
        const client = new AzDoApiClient(
            createSpyAuthProvider(),
            createRemoteInfo(),
            createMockLog(),
        );
        client.resetConnection();
        assert.strictEqual(client.isConnected, false);
        client.dispose();
    });
});

suite('AzDoApiClient — tryConnectSilently', () => {
    test('returns false when no token available silently', async () => {
        const auth = createSpyAuthProvider(undefined);
        const client = new AzDoApiClient(auth, createRemoteInfo(), createMockLog());

        const result = await client.tryConnectSilently();

        assert.strictEqual(result, false);
        assert.strictEqual(auth.calls.length, 1);
        assert.strictEqual(auth.calls[0].options?.silent, true);
        client.dispose();
    });

    test('passes cached tenant ID to getToken in silent mode', async () => {
        const tenantId = 'tenant-abc-123';
        const tenantCache = {
            get: (org: string) => org === 'myorg' ? tenantId : undefined,
            set: () => { },
        };
        const auth = createSpyAuthProvider(undefined); // no token — we just want to inspect the call
        const client = new AzDoApiClient(auth, createRemoteInfo(), createMockLog(), tenantCache);

        await client.tryConnectSilently();

        assert.strictEqual(auth.calls.length, 1);
        assert.strictEqual(auth.calls[0].options?.silent, true);
        assert.strictEqual(auth.calls[0].options?.tenantId, tenantId,
            'tryConnectSilently must pass cached tenantId to getToken');
        client.dispose();
    });

    test('preserves tenant ID after resetConnection + silent retry', async () => {
        const tenantId = 'tenant-xyz-789';
        const tenantCache = {
            get: (org: string) => org === 'myorg' ? tenantId : undefined,
            set: () => { },
        };
        const auth = createSpyAuthProvider(undefined);
        const client = new AzDoApiClient(auth, createRemoteInfo(), createMockLog(), tenantCache);

        // First silent attempt — captures tenant
        await client.tryConnectSilently();
        assert.strictEqual(auth.calls[0].options?.tenantId, tenantId);

        // Reset connection (simulating token expiry/handleAuthError)
        client.resetConnection();
        assert.strictEqual(client.isConnected, false);

        // Second silent attempt — tenant ID must still be present
        await client.tryConnectSilently();
        assert.strictEqual(auth.calls.length, 2);
        assert.strictEqual(auth.calls[1].options?.tenantId, tenantId,
            'tenantId must survive resetConnection — it should NOT be cleared');
        assert.strictEqual(auth.calls[1].options?.silent, true);
        client.dispose();
    });

    test('returns false on auth error during validation (no throw)', async () => {
        // Use a local HTTP server that returns 401 to trigger auth error on connect()
        const server = http.createServer((_req, res) => {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('401 Unauthorized');
        });

        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const addr = server.address() as { port: number };
        const baseUrl = `http://127.0.0.1:${addr.port}`;

        const auth = createSpyAuthProvider('valid-token');
        const client = new AzDoApiClient(auth, createRemoteInfo('myorg', baseUrl), createMockLog());

        const result = await client.tryConnectSilently();

        assert.strictEqual(result, false, 'should return false on auth error, not throw');
        assert.strictEqual(client.isConnected, false);

        client.dispose();
        await new Promise<void>(resolve => server.close(() => resolve()));
    });
});

suite('AzDoApiClient — doConnect multi-tenant flow', () => {
    test('doConnect passes cached tenant ID to getToken (interactive)', async () => {
        // doConnect is private, but we can trigger it via getCurrentUserId()
        // which calls getConnection() → doConnect().
        // The connection will fail because there's no real AzDO server,
        // but we can inspect whether the correct tenant was passed.

        const tenantId = 'multi-tenant-id';
        const tenantCache = {
            get: (org: string) => org === 'myorg' ? tenantId : undefined,
            set: () => { },
        };
        const auth = createSpyAuthProvider('some-token');
        const client = new AzDoApiClient(
            auth,
            createRemoteInfo('myorg', 'http://127.0.0.1:1'), // unreachable — will fail at connect()
            createMockLog(),
            tenantCache,
        );

        try {
            await client.getCurrentUserId();
        } catch {
            // Expected — no real server
        }

        assert.strictEqual(auth.calls.length >= 1, true);
        assert.strictEqual(auth.calls[0].options?.tenantId, tenantId,
            'doConnect must pass cached tenantId to getToken for interactive login');
        // Should NOT have silent: true — this is the interactive path
        assert.strictEqual(auth.calls[0].options?.silent, undefined);

        client.dispose();
    });

    test('full cycle: silent fail → sign-in → reset → silent retry uses tenant', async () => {
        // Simulates the multi-tenant lifecycle:
        //   1. Startup: silent auth fails (no cached token)
        //   2. User signs in: interactive doConnect, connection fails (wrong tenant)
        //   3. Token expires: resetConnection
        //   4. Silent retry: must still pass tenantId
        //
        // A local server returns 401 so doConnect triggers retryWithTenantDiscovery,
        // which then also fails (the test has no tenant discovery server).
        // We only care about the getToken call arguments at each stage.
        const tenantId = 'persistent-tenant';
        const tenantCache = {
            get: (org: string) => org === 'myorg' ? tenantId : undefined,
            set: () => { },
        };
        const auth = createSpyAuthProvider(undefined); // start with no token

        const server = http.createServer((_req, res) => {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('401 Unauthorized');
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const addr = server.address() as { port: number };
        const baseUrl = `http://127.0.0.1:${addr.port}`;

        const client = new AzDoApiClient(
            auth,
            createRemoteInfo('myorg', baseUrl),
            createMockLog(),
            tenantCache,
        );

        // 1. Silent connect fails — no token
        const silentResult = await client.tryConnectSilently();
        assert.strictEqual(silentResult, false);
        assert.strictEqual(auth.calls[0].options?.silent, true);
        assert.strictEqual(auth.calls[0].options?.tenantId, tenantId);

        // 2. User signs in — interactive doConnect gets token, server returns 401,
        //    triggers retryWithTenantDiscovery (which fails → TenantMismatchError).
        auth.setToken('interactive-token');
        try {
            await client.getCurrentUserId();
        } catch {
            // Expected — TenantMismatchError or network error from tenant discovery
        }
        // First call in step 2 should be the interactive getToken with tenantId
        const interactiveCall = auth.calls[1];
        assert.strictEqual(interactiveCall.options?.tenantId, tenantId,
            'interactive doConnect must use cached tenant');
        assert.strictEqual(interactiveCall.options?.silent, undefined,
            'interactive doConnect must NOT be silent');

        // 3. Token expires — reset
        client.resetConnection();

        // 4. Silent retry — tenant must still be present
        auth.setToken(undefined);
        const retryResult = await client.tryConnectSilently();
        assert.strictEqual(retryResult, false);
        const retryCall = auth.calls[auth.calls.length - 1];
        assert.strictEqual(retryCall.options?.tenantId, tenantId,
            'after reset, silent retry must still pass tenantId');
        assert.strictEqual(retryCall.options?.silent, true);

        client.dispose();
        await new Promise<void>(resolve => server.close(() => resolve()));
    });
});

suite('isAuthError', () => {
    test('detects 401', () => assert.ok(isAuthError(new Error('HTTP 401'))));
    test('detects 403', () => assert.ok(isAuthError(new Error('Status 403 Forbidden'))));
    test('detects unauthorized', () => assert.ok(isAuthError(new Error('Unauthorized'))));
    test('detects TF400813', () => assert.ok(isAuthError(new Error('TF400813: not authorized'))));
    test('detects "not authorized to access"', () => assert.ok(isAuthError(new Error('not authorized to access this resource'))));
    test('rejects network error', () => assert.ok(!isAuthError(new Error('ECONNREFUSED'))));
    test('rejects null', () => assert.ok(!isAuthError(null)));
    test('rejects undefined', () => assert.ok(!isAuthError(undefined)));
});
