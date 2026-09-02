/**
 * Utilities for detecting and rendering Azure DevOps code suggestions
 * as diff-style markdown.
 *
 * AzDO suggestions appear in comment content as:
 * ```suggestion
 * suggested replacement code
 * ```
 */

/** Regex to extract a suggestion code block from markdown content. */
const SUGGESTION_RE = /```suggestion\s*\n([\s\S]*?)```/;

/**
 * Check whether a comment's content contains an AzDO suggestion block.
 */
export function hasSuggestion(content: string): boolean {
    return SUGGESTION_RE.test(content);
}

/**
 * Extract the suggested code from a comment, if present.
 * Returns `undefined` if no suggestion block is found.
 */
export function extractSuggestion(content: string): string | undefined {
    const match = content.match(SUGGESTION_RE);
    if (!match) { return undefined; }
    // Remove trailing newline that's part of the fence
    return match[1].replaceAll('\r\n', '\n').replace(/\n$/, '');
}

/**
 * Get the text surrounding the suggestion block (the reviewer's commentary).
 * Returns the content with the suggestion block removed.
 */
export function extractCommentText(content: string): string {
    return content.replace(SUGGESTION_RE, '').trim();
}

/**
 * Render a suggestion as a diff-style markdown string.
 *
 * @param originalLines  The original code lines (full lines from the file)
 * @param suggestedCode  The raw suggested replacement code (from the suggestion block)
 * @param commentText    Optional commentary from the reviewer
 * @param replacedLines  If provided, used as the `+` side of the diff.
 *                       This should be the full lines with the selected span
 *                       replaced by the suggestion. If not provided, falls back
 *                       to showing `suggestedCode` lines directly.
 */
export function renderSuggestionAsDiff(
    originalLines: string[],
    suggestedCode: string,
    commentText?: string,
    replacedLines?: string[],
): string {
    const addedLines = replacedLines ?? suggestedCode.split(/\r?\n/);

    const diffLines: string[] = [];

    // Original lines as removals
    for (const line of originalLines) {
        diffLines.push(`- ${line}`);
    }
    // Replaced/suggested lines as additions
    for (const line of addedLines) {
        diffLines.push(`+ ${line}`);
    }

    let md = '';
    if (commentText) {
        md += commentText + '\n\n';
    }
    md += '```diff\n' + diffLines.join('\n') + '\n```';
    return md;
}
