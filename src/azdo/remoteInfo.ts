import type { Repository } from '../typings/git';

/** Parsed Azure DevOps remote fields (pure data, no VS Code Git references). */
export interface ParsedAzDoRemote {
    /** Azure DevOps organization name. */
    readonly organization: string;
    /** Azure DevOps project name. */
    readonly project: string;
    /** Git repository name within the project. */
    readonly repositoryName: string;
    /** Original remote URL as configured in git. */
    readonly remoteUrl: string;
    /** Git remote name (e.g. "origin"). */
    readonly remoteName: string;
    /** Normalized API base URL: https://dev.azure.com/{org} */
    readonly apiBaseUrl: string;
}

/** Parsed Azure DevOps remote information, enriched with the matched git Repository. */
export interface AzDoRemoteInfo extends ParsedAzDoRemote {
    /** The VS Code Git repository that contains this remote. */
    readonly repository: Repository;
}
