/** Parsed Azure DevOps remote information. */
export interface AzDoRemoteInfo {
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
