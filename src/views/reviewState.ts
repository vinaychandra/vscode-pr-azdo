/** Workspace-state key for reviewed files in one pull request. */
export function reviewedFilesStateKey(pullRequestId: number): string {
    return `reviewedFiles-${pullRequestId}`;
}