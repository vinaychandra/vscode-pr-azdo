import * as assert from 'assert';
import * as http from 'http';
import { discoverOrgTenantId } from '../../azdo/auth/tenantDiscovery';

/** Minimal stub for vscode.OutputChannel used by discoverOrgTenantId. */
function stubLog(): { appendLine(v: string): void; lines: string[] } {
    const lines: string[] = [];
    return {
        lines,
        appendLine(v: string) { lines.push(v); },
    };
}

suite('tenantDiscovery', () => {
    let server: http.Server;
    let baseUrl: string;

    // Spin up a local HTTP server for each test
    setup(done => {
        server = http.createServer();
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            baseUrl = `http://127.0.0.1:${addr.port}`;
            done();
        });
    });

    teardown(done => {
        server.close(done);
    });

    test('extracts tenant from X-VSS-ResourceTenant on 200 (connectionData)', async () => {
        const tenantId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
        server.on('request', (_req, res) => {
            // connectionData returns 200 with tenant header (anonymous-friendly)
            res.writeHead(200, {
                'X-VSS-ResourceTenant': tenantId,
            });
            res.end('{}');
        });

        const log = stubLog();
        const result = await discoverOrgTenantId(baseUrl, log as any);
        assert.strictEqual(result, tenantId);
    });

    test('extracts tenant from WWW-Authenticate on 401 (projects fallback)', async () => {
        const tenantId = 'f0e1d2c3-b4a5-6789-0abc-def123456789';
        server.on('request', (req, res) => {
            if (req.url?.includes('connectionData')) {
                // connectionData returns 200 with no tenant header
                res.writeHead(200);
                res.end('{}');
            } else {
                // projects returns 401 with WWW-Authenticate
                res.writeHead(401, {
                    'WWW-Authenticate': `Bearer authorization_uri=https://login.microsoftonline.com/${tenantId}`,
                });
                res.end();
            }
        });

        const log = stubLog();
        const result = await discoverOrgTenantId(baseUrl, log as any);
        assert.strictEqual(result, tenantId);
    });

    test('X-VSS-ResourceTenant on first endpoint short-circuits (no second request)', async () => {
        const tenantId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
        let requestCount = 0;
        server.on('request', (_req, res) => {
            requestCount++;
            res.writeHead(200, {
                'X-VSS-ResourceTenant': tenantId,
            });
            res.end('{}');
        });

        const log = stubLog();
        const result = await discoverOrgTenantId(baseUrl, log as any);
        assert.strictEqual(result, tenantId);
        assert.strictEqual(requestCount, 1, 'should only hit connectionData endpoint');
    });

    test('returns undefined when no endpoint returns tenant headers', async () => {
        server.on('request', (_req, res) => {
            res.writeHead(200);
            res.end('{}');
        });

        const log = stubLog();
        const result = await discoverOrgTenantId(baseUrl, log as any);
        assert.strictEqual(result, undefined);
    });

    test('returns undefined when 401 has no tenant headers', async () => {
        server.on('request', (_req, res) => {
            res.writeHead(401);
            res.end();
        });

        const log = stubLog();
        const result = await discoverOrgTenantId(baseUrl, log as any);
        assert.strictEqual(result, undefined);
    });

    test('returns undefined when WWW-Authenticate has non-GUID path', async () => {
        server.on('request', (_req, res) => {
            res.writeHead(401, {
                'WWW-Authenticate': 'Bearer authorization_uri=https://login.microsoftonline.com/common',
            });
            res.end();
        });

        const log = stubLog();
        const result = await discoverOrgTenantId(baseUrl, log as any);
        assert.strictEqual(result, undefined);
    });

    test('extracts tenant from X-VSS-ResourceTenant on 401', async () => {
        const tenantId = '11111111-2222-3333-4444-555555555555';
        server.on('request', (_req, res) => {
            res.writeHead(401, {
                'X-VSS-ResourceTenant': tenantId,
            });
            res.end();
        });

        const log = stubLog();
        const result = await discoverOrgTenantId(baseUrl, log as any);
        assert.strictEqual(result, tenantId);
    });
});
