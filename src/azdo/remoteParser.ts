import type { AzDoRemoteInfo } from './remoteInfo';

// --- HTTPS: dev.azure.com ---
// https://dev.azure.com/{org}/{project}/_git/{repo}
// Optional userinfo (user@), optional trailing slash or .git
const DEV_AZURE_COM_RE =
    /^https?:\/\/(?:[^@]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/i;

// --- HTTPS: visualstudio.com ---
// https://{org}.visualstudio.com/{project}/_git/{repo}
// Also handles the DefaultCollection path segment
const VISUALSTUDIO_COM_RE =
    /^https?:\/\/(?:[^@]+@)?([^.]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/i;

// --- SSH: ssh.dev.azure.com ---
// git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
const SSH_DEV_AZURE_COM_RE =
    /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

// --- SSH: legacy vs-ssh.visualstudio.com ---
// git@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
const SSH_VS_RE =
    /^git@vs-ssh\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

const PATTERNS: ReadonlyArray<RegExp> = [
    DEV_AZURE_COM_RE,
    VISUALSTUDIO_COM_RE,
    SSH_DEV_AZURE_COM_RE,
    SSH_VS_RE,
];

/**
 * Parse a git remote URL and extract Azure DevOps organization, project, and
 * repository information. Returns `undefined` if the URL is not a recognized
 * Azure DevOps remote.
 */
export function parseAzDoRemote(url: string, remoteName: string): AzDoRemoteInfo | undefined {
    for (const pattern of PATTERNS) {
        const match = url.match(pattern);
        if (match) {
            const [, organization, project, repositoryName] = match;
            return {
                organization: decodeURIComponent(organization),
                project: decodeURIComponent(project),
                repositoryName: decodeURIComponent(repositoryName),
                remoteUrl: url,
                remoteName,
                apiBaseUrl: `https://dev.azure.com/${encodeURIComponent(organization)}`,
            };
        }
    }
    return undefined;
}
