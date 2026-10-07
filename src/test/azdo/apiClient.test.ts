import * as assert from 'assert';
import * as http from 'http';
import * as vscode from 'vscode';
import { EntraIdAuthProvider } from '../../azdo/auth/entraIdAuthProvider';
import { AzDoApiClient, TenantMismatchError, isAuthError } from '../../azdo/apiClient';
import type { IAuthProvider, GetTokenOptions } from '../../azdo/auth/iAuthProvider';
import type { AzDoRemoteInfo } from '../../azdo/remoteInfo';

/** Capture every getToken call for assertions. */
interface TokenCall {
    options: GetTokenOptions | undefined;
}

function createSpyAuthProvider(token: string | undefined = undefined) {
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
    test('shares connection creation across concurrent silent requests', async () => {
        const auth = createSpyAuthProvider();
        let completeToken!: (token: string | undefined) => void;
        const token = new Promise<string | undefined>(resolve => { completeToken = resolve; });
        auth.getToken = async options => { auth.calls.push({ options }); return token; };
        const client = new AzDoApiClient(auth, createRemoteInfo(), createMockLog());
        const first = client.tryConnectSilently();
        const second = client.tryConnectSilently();
        completeToken(undefined);
        assert.deepStrictEqual(await Promise.all([first, second]), [false, false]);
        assert.strictEqual(auth.calls.length, 1);
        assert.strictEqual(auth.calls[0].options?.silent, true);
        client.dispose();
    });

    test('an explicit sign-in can continue after in-flight silent startup fails', async () => {
        const auth = createSpyAuthProvider();
        let completeToken!: (token: string | undefined) => void;
        const token = new Promise<string | undefined>(resolve => { completeToken = resolve; });
        auth.getToken = async options => {
            auth.calls.push({ options });
            return options?.silent ? token : undefined;
        };
        const client = new AzDoApiClient(auth, createRemoteInfo(), createMockLog());
        const startup = client.tryConnectSilently();
        const signIn = assert.rejects(client.getCurrentUserId(true), /Authentication required/);
        completeToken(undefined);
        assert.strictEqual(await startup, false);
        await signIn;
        assert.deepStrictEqual(auth.calls.map(call => call.options?.silent), [true, false]);
        client.dispose();
    });

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
    test('discovers a tenant and uses its cached session without forcing sign-in', async () => {
        const tenantId = '11111111-2222-3333-4444-555555555555';
        const auth = createSpyAuthProvider();
        auth.getToken = async options => {
            auth.calls.push({ options });
            return options?.tenantId === tenantId ? 'tenant-token' : 'wrong-tenant-token';
        };
        const discovered: string[] = [];
        const server = http.createServer((request, response) => {
            response.setHeader('X-VSS-ResourceTenant', tenantId);
            response.setHeader('Content-Type', 'application/json');
            if (request.headers.authorization !== 'Bearer tenant-token') {
                response.writeHead(401);
                response.end(JSON.stringify({ message: 'Access denied' }));
                return;
            }
            response.end(JSON.stringify({ authenticatedUser: { id: 'tenant-user' } }));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address() as { port: number };
        const client = new AzDoApiClient(auth, createRemoteInfo('myorg', `http://127.0.0.1:${address.port}`), createMockLog(), {
            get: () => undefined,
            set: (_organization, tenant) => { discovered.push(tenant); },
        });
        try {
            assert.strictEqual(await client.tryConnectSilently(), true);
            assert.strictEqual(await client.getCurrentUserId(), 'tenant-user');
            assert.deepStrictEqual(discovered, [tenantId]);
            assert.strictEqual(auth.calls.length, 2);
            assert.strictEqual(auth.calls[1].options?.tenantId, tenantId);
            assert.ok(auth.calls.every(call => call.options?.silent === true && !call.options.forceNew));
        } finally {
            client.dispose();
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

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
            await client.getCurrentUserId(true);
        } catch {
            // Expected — no real server
        }

        assert.strictEqual(auth.calls.length >= 1, true);
        assert.strictEqual(auth.calls[0].options?.tenantId, tenantId,
            'doConnect must pass cached tenantId to getToken for interactive login');
        assert.strictEqual(auth.calls[0].options?.silent, false);

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
            await client.getCurrentUserId(true);
        } catch {
            // Expected — TenantMismatchError or network error from tenant discovery
        }
        // First call in step 2 should be the interactive getToken with tenantId
        const interactiveCall = auth.calls[1];
        assert.strictEqual(interactiveCall.options?.tenantId, tenantId,
            'interactive doConnect must use cached tenant');
        assert.strictEqual(interactiveCall.options?.silent, false,
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

suite('AzDoApiClient — auth recovery', () => {
    test('renews an expired SDK bearer connection silently and retries the request', async () => {
        let acceptedToken = 'old-token';
        const requests: (string | undefined)[] = [];
        const server = http.createServer((request, response) => {
            requests.push(request.headers.authorization);
            response.setHeader('Content-Type', 'application/json');
            if (request.headers.authorization !== `Bearer ${acceptedToken}`) {
                response.writeHead(401);
                response.end(JSON.stringify({ message: 'Access denied' }));
                return;
            }
            response.end(JSON.stringify({ authenticatedUser: { id: 'test-user' } }));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address() as { port: number };
        const auth = createSpyAuthProvider('old-token');
        const client = new AzDoApiClient(auth, createRemoteInfo('myorg', `http://127.0.0.1:${address.port}`), createMockLog());
        try {
            assert.strictEqual(await client.tryConnectSilently(), true);
            acceptedToken = 'renewed-token';
            auth.setToken(acceptedToken);

            const result = await client.withAuthRecovery(async () => {
                const connection = await (client as any).getConnection();
                return connection.connect() as Promise<{ authenticatedUser: { id: string } }>;
            });
            assert.strictEqual(result.authenticatedUser.id, 'test-user');
            assert.strictEqual(auth.calls.length, 2);
            assert.ok(requests.includes('Bearer old-token'));
            assert.ok(requests.includes('Bearer renewed-token'));

            client.resetConnection();
            auth.setToken(undefined);
            await assert.rejects(client.getCurrentUserId(), /Authentication required/);
            assert.ok(auth.calls.every(call => call.options?.silent === true && !call.options.forceNew));
        } finally {
            client.dispose();
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    test('a request arriving during failed silent recovery never starts interactive authentication', async () => {
        const auth = createSpyAuthProvider(undefined);
        const client = new AzDoApiClient(auth, createRemoteInfo(), createMockLog());
        let completeRecovery!: (connected: boolean) => void;
        const recovery = new Promise<boolean>(resolve => { completeRecovery = resolve; });
        (client as any).tryConnectSilently = () => recovery;

        const failing = assert.rejects(client.withAuthRecovery(async () => {
            throw new Error('HTTP 401 Unauthorized');
        }), /401/);
        await new Promise(resolve => setTimeout(resolve, 0));
        const concurrent = assert.rejects(client.getCurrentUserId(), /Authentication required/);
        completeRecovery(false);
        await Promise.all([failing, concurrent]);

        assert.strictEqual(auth.calls.length, 0, 'Concurrent reads must wait for recovery, not request an interactive token.');
        client.dispose();
    });

    test('retries the operation once after silent recovery succeeds', async () => {
        const client = new AzDoApiClient(createSpyAuthProvider(), createRemoteInfo(), createMockLog());
        let operationCalls = 0;
        let recoveryCalls = 0;
        (client as any).tryConnectSilently = async () => {
            recoveryCalls++;
            return true;
        };

        const result = await client.withAuthRecovery(async () => {
            operationCalls++;
            if (operationCalls === 1) {
                throw new Error('TF400813: User is not authorized');
            }
            return 'recovered';
        });

        assert.strictEqual(result, 'recovered');
        assert.strictEqual(operationCalls, 2);
        assert.strictEqual(recoveryCalls, 1);
        client.dispose();
    });

    test('rethrows the original error when silent recovery is unavailable', async () => {
        const client = new AzDoApiClient(createSpyAuthProvider(), createRemoteInfo(), createMockLog());
        const originalError = new Error('User aaaaa is not authorized');
        let operationCalls = 0;
        (client as any).tryConnectSilently = async () => false;

        await assert.rejects(
            client.withAuthRecovery(async () => {
                operationCalls++;
                throw originalError;
            }),
            err => err === originalError,
        );

        assert.strictEqual(operationCalls, 1);
        client.dispose();
    });

    test('does not retry non-auth errors', async () => {
        const client = new AzDoApiClient(createSpyAuthProvider(), createRemoteInfo(), createMockLog());
        let operationCalls = 0;
        let recoveryCalls = 0;
        (client as any).tryConnectSilently = async () => {
            recoveryCalls++;
            return true;
        };

        await assert.rejects(client.withAuthRecovery(async () => {
            operationCalls++;
            throw new Error('ECONNRESET');
        }));

        assert.strictEqual(operationCalls, 1);
        assert.strictEqual(recoveryCalls, 0);
        client.dispose();
    });

    test('shares one silent recovery across concurrent auth failures', async () => {
        const client = new AzDoApiClient(createSpyAuthProvider(), createRemoteInfo(), createMockLog());
        let recoveryCalls = 0;
        let completeRecovery!: (connected: boolean) => void;
        const recovery = new Promise<boolean>(resolve => { completeRecovery = resolve; });
        (client as any).tryConnectSilently = () => {
            recoveryCalls++;
            return recovery;
        };

        const attempts = new Map<string, number>();
        const run = (name: string) => client.withAuthRecovery(async () => {
            const attempt = (attempts.get(name) ?? 0) + 1;
            attempts.set(name, attempt);
            if (attempt === 1) {
                throw new Error('HTTP 401 Unauthorized');
            }
            return name;
        });

        const first = run('first');
        const second = run('second');
        await new Promise(resolve => setTimeout(resolve, 0));
        completeRecovery(true);

        assert.deepStrictEqual(await Promise.all([first, second]), ['first', 'second']);
        assert.strictEqual(recoveryCalls, 1);
        client.dispose();
    });
});

suite('EntraIdAuthProvider - silent contract', () => {
    test('explicit account switching still permits a forced session', async () => {
        const calls: (vscode.AuthenticationGetSessionOptions | undefined)[] = [];
        const provider = new EntraIdAuthProvider(createMockLog(), async (_providerId, _scopes, options) => {
            calls.push(options);
            return undefined;
        });
        try {
            await provider.getToken({ forceNew: true });
            assert.strictEqual(calls.length, 1);
            assert.ok(calls[0]?.forceNewSession);
            assert.strictEqual(calls[0]?.clearSessionPreference, true);
            assert.notStrictEqual(calls[0]?.silent, true);
        } finally {
            provider.dispose();
        }
    });

    for (const forceNew of [false, true]) {
        test(`silent acquisition never creates or forces a session (forceNew=${forceNew})`, async () => {
            const calls: (vscode.AuthenticationGetSessionOptions | undefined)[] = [];
            const readSession = async (_providerId: string, _scopes: readonly string[], options?: vscode.AuthenticationGetSessionOptions) => {
                calls.push(options);
                return undefined;
            };
            const provider = new EntraIdAuthProvider(createMockLog(), readSession);
            try {
                assert.strictEqual(await provider.getToken({ silent: true, forceNew }), undefined);
                assert.deepStrictEqual(calls, [{ silent: true }]);
            } finally {
                provider.dispose();
            }
        });
    }

    test('gets renewed tokens from Microsoft auth rather than retaining an old token', async () => {
        let request = 0;
        const readSession = async () => ({
            id: 'session', accessToken: `token-${++request}`,
            account: { id: 'account', label: 'Test' }, scopes: [],
        });
        const provider = new EntraIdAuthProvider(createMockLog(), readSession);
        try {
            assert.strictEqual(await provider.getToken({ silent: true }), 'token-1');
            assert.strictEqual(await provider.getToken({ silent: true }), 'token-2');
        } finally {
            provider.dispose();
        }
    });
});

suite('isAuthError', () => {
    test('detects 401', () => assert.ok(isAuthError(new Error('HTTP 401'))));
    test('detects 403', () => assert.ok(isAuthError(new Error('Status 403 Forbidden'))));
    test('detects an SDK 401 even when the error message omits the status', () => assert.ok(isAuthError(Object.assign(new Error('Access denied'), { statusCode: 401 }))));
    test('detects a response 403 even when the error message omits the status', () => assert.ok(isAuthError({ status: 403, message: 'Access denied' })));
    test('detects unauthorized', () => assert.ok(isAuthError(new Error('Unauthorized'))));
    test('detects TF400813', () => assert.ok(isAuthError(new Error('TF400813: not authorized'))));
    test('detects "not authorized to access"', () => assert.ok(isAuthError(new Error('not authorized to access this resource'))));
    test('detects plain "user is not authorized"', () => assert.ok(isAuthError(new Error('User aaaaa is not authorized'))));
    test('rejects network error', () => assert.ok(!isAuthError(new Error('ECONNREFUSED'))));
    test('rejects null', () => assert.ok(!isAuthError(null)));
    test('rejects undefined', () => assert.ok(!isAuthError(undefined)));
});
