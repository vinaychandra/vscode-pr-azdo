import type { ParsedAzDoRemote } from './remoteInfo';

export interface ParsedAzDoPullRequestUrl {
    organization: string;
    project: string;
    repositoryName: string;
    pullRequestId: number;
    repositoryUrl: string;
}

export function isSameAzDoRepository(
    pullRequestUrl: ParsedAzDoPullRequestUrl,
    remote: ParsedAzDoRemote,
): boolean {
    return equalsIgnoreCase(pullRequestUrl.organization, remote.organization)
        && equalsIgnoreCase(pullRequestUrl.project, remote.project)
        && equalsIgnoreCase(pullRequestUrl.repositoryName, remote.repositoryName);
}

export function parseAzDoPullRequestUrl(value: string): ParsedAzDoPullRequestUrl | undefined {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        return undefined;
    }

    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) { return undefined; }

    const segments = url.pathname.split('/').filter(Boolean);
    const gitIndex = segments.findIndex(segment => segment.toLowerCase() === '_git');
    if (gitIndex < 0 || segments[gitIndex + 2]?.toLowerCase() !== 'pullrequest') { return undefined; }

    const pullRequestId = Number(segments[gitIndex + 3]);
    if (!Number.isSafeInteger(pullRequestId) || pullRequestId <= 0 || gitIndex + 4 !== segments.length) {
        return undefined;
    }

    let organization: string;
    let projectIndex: number;
    const host = url.hostname.toLowerCase();
    if (host === 'dev.azure.com') {
        if (gitIndex !== 2) { return undefined; }
        organization = decode(segments[0]);
        projectIndex = 1;
    } else if (host.endsWith('.visualstudio.com')) {
        organization = url.hostname.substring(0, url.hostname.length - '.visualstudio.com'.length);
        projectIndex = segments[0]?.toLowerCase() === 'defaultcollection' ? 1 : 0;
        if (gitIndex !== projectIndex + 1) { return undefined; }
    } else {
        return undefined;
    }

    const project = decode(segments[projectIndex]);
    const repositoryName = decode(segments[gitIndex + 1]);
    if (!organization || !project || !repositoryName) { return undefined; }

    const repositoryUrl = new URL(url.toString());
    repositoryUrl.pathname = `/${segments.slice(0, gitIndex + 2).join('/')}`;
    repositoryUrl.search = '';
    repositoryUrl.hash = '';

    return { organization, project, repositoryName, pullRequestId, repositoryUrl: repositoryUrl.toString().replace(/\/$/, '') };
}

function decode(value: string | undefined): string {
    if (!value) { return ''; }
    try {
        return decodeURIComponent(value);
    } catch {
        return '';
    }
}

function equalsIgnoreCase(first: string, second: string): boolean {
    return first.localeCompare(second, undefined, { sensitivity: 'accent' }) === 0;
}