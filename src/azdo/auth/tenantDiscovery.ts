import * as https from 'https';
import * as http from 'http';
import type * as vscode from 'vscode';

/**
 * Discover the Entra tenant ID that owns an Azure DevOps organization.
 *
 * Strategy:
 *  1. Hit `{org}/_apis/connectionData` (anonymous-friendly) and look for
 *     the `X-VSS-ResourceTenant` header — Azure DevOps returns it on
 *     every response regardless of auth status.
 *  2. If that fails, hit `{org}/_apis/projects` (requires auth) to get a
 *     401 with `WWW-Authenticate: Bearer authorization_uri=…/{tenantId}`.
 *
 * Returns the tenant ID (a GUID) or `undefined` if discovery fails.
 */
export async function discoverOrgTenantId(
    apiBaseUrl: string,
    log: vscode.OutputChannel,
): Promise<string | undefined> {
    log.appendLine(`[tenant] Discovering tenant for ${apiBaseUrl} …`);

    try {
        // Strategy 1: connectionData — check X-VSS-ResourceTenant on any status
        const connDataUrl = `${apiBaseUrl}/_apis/connectionData`;
        const connHeaders = await getResponseHeaders(connDataUrl);
        if (connHeaders) {
            const tid = extractTenantFromHeaders(connHeaders);
            if (tid) {
                log.appendLine(`[tenant] Discovered tenant from connectionData headers: ${tid}`);
                return tid;
            }
        }

        // Strategy 2: projects endpoint — requires auth, so anonymous gets 401
        const projectsUrl = `${apiBaseUrl}/_apis/projects`;
        const projHeaders = await getResponseHeaders(projectsUrl);
        if (projHeaders) {
            const tid = extractTenantFromHeaders(projHeaders);
            if (tid) {
                log.appendLine(`[tenant] Discovered tenant from projects 401 headers: ${tid}`);
                return tid;
            }
        }

        log.appendLine('[tenant] Could not discover tenant from any endpoint.');
        return undefined;
    } catch (err) {
        log.appendLine(`[tenant] Tenant discovery failed: ${err}`);
        return undefined;
    }
}

/**
 * Extract a tenant GUID from response headers.
 * Checks `X-VSS-ResourceTenant` and `WWW-Authenticate` (in that order).
 */
function extractTenantFromHeaders(headers: http.IncomingHttpHeaders): string | undefined {
    // X-VSS-ResourceTenant (present on most AzDO responses)
    const resourceTenant = headers['x-vss-resourcetenant'];
    if (resourceTenant) {
        const tid = (typeof resourceTenant === 'string' ? resourceTenant : resourceTenant[0]).trim();
        if (/^[0-9a-f-]{36}$/i.test(tid)) {
            return tid;
        }
    }

    // WWW-Authenticate (present on 401 responses)
    const wwwAuth = headers['www-authenticate'];
    if (wwwAuth) {
        const match = /authorization_uri=https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})/i.exec(
            typeof wwwAuth === 'string' ? wwwAuth : wwwAuth[0],
        );
        if (match) {
            return match[1];
        }
    }

    return undefined;
}

/**
 * Fire a GET request and return the response headers regardless of status code.
 * Resolves to `undefined` on network errors.
 */
function getResponseHeaders(
    url: string,
): Promise<http.IncomingHttpHeaders | undefined> {
    return new Promise(resolve => {
        const transport = url.startsWith('https') ? https : http;
        const req = transport.get(url, { timeout: 10_000 }, res => {
            // Consume body so socket is freed
            res.resume();
            resolve(res.headers);
        });
        req.on('error', () => resolve(undefined));
        req.on('timeout', () => {
            req.destroy();
            resolve(undefined);
        });
    });
}
