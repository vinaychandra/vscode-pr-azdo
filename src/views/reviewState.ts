/** Workspace-state key for reviewed files in one pull request. */
export function reviewedFilesStateKey(reviewScope: number | string): string {
    return `reviewedFiles-${reviewScope}`;
}