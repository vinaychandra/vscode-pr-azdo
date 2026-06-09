# Change Log

All notable changes to the "vscode-pr-azdo" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.
## [Unreleased]

### Added

- **Deleted files in the Active PR view** — files removed in a pull request now appear in the Files tree with a red trash-style icon and a "Delete" badge. Clicking a deleted file opens its old content (from the target branch) as a read-only editor, so you can read what was removed and comment on it directly. Added/renamed files also get themed icons (`diff-added` green / `diff-renamed`).
- **Comments on deleted files** — existing Azure DevOps comments on deleted files now render at their original line on the gutter, and you can post new comments by clicking the `+` gutter icon. New comments are posted as left-side threads (`leftFileStart`/`leftFileEnd`) so they anchor correctly on AzDO.

### Fixed

- **Deleted files were missing from the tree** — Azure DevOps returns deleted file paths on the top-level `originalPath` field instead of `item.path` (which is `null` for deletes). The tree builder and change-type map now read both, so deletes appear correctly.
- **Refresh now fetches from remote** — both the Pull Requests and Active PR refresh buttons now run `git fetch` before re-querying Azure DevOps, so remote-tracking branches (and therefore diffs against `origin/main`) reflect the latest server state.
- **Checkout now fast-forwards the PR branch** — when checking out a PR branch that already exists locally but is behind its upstream (e.g. teammate pushed new commits), the extension now fast-forwards the local branch instead of leaving you on a stale revision. If the branch has diverged from the remote (force-push + local commits), you're prompted to either reset to the remote or keep the local copy.
## [0.0.12]

### Added

- **Deleted files in the Active PR view** — files removed in the pull request now appear in the Files tree alongside additions and edits, with a red `diff-removed` icon and a "Delete" label. Added files use a green `diff-added` icon; renames use `diff-renamed`. Clicking a deleted file opens the original content from the target branch in a read-only editor.
- **Comments on deleted files** — existing Azure DevOps comments on deleted files now render inline at their original lines, and you can create new comments via the gutter `+` just like on edited files. Drafts and replies on deleted files are anchored to the correct side of the PR (`leftFileStart`) when posted to Azure DevOps.

### Fixed

- **Delete change entries were silently dropped** — Azure DevOps returns deletes with `item.path = null` and the path on a top-level `originalPath` field; the parser was only reading `item.path`, so deleted files were missing from the tree entirely. A new shared `getChangePath` helper handles both shapes.

## [0.0.11]

### Changed

- **Lazy authentication** — the extension no longer prompts for login on startup or during background operations. Authentication is deferred until the user explicitly needs it (e.g. clicking "Sign In", expanding a PR category, posting a comment). This eliminates disruptive login prompts in idle VS Code windows, especially when working across multiple projects and tenants.
- **Silent token refresh** — when a token expires mid-session, the extension first attempts a silent refresh. If the silent refresh succeeds, the user sees no interruption. If it fails, tree views show a "Sign In" item instead of prompting immediately.

### Added

- **Sign In tree item** — when not authenticated, both the "Pull Requests" and "Active Pull Request" tree views show a clickable "Sign in to Azure DevOps" item that triggers interactive login on demand.

### Fixed

- **Multi-tenant Switch Account** — the "Switch Account" command now passes the cached Entra tenant ID when forcing a new session, preventing a scope mismatch that would require signing in twice on multi-tenant orgs.
- **Active PR not detected after silent auth** — fixed a race condition where the active PR was not detected after silent authentication completed, because the initial detection ran before the connection was established.

## [0.0.10]

### Added

- **Draft comments** — write comments locally without posting to Azure DevOps, then publish them when ready.
  - **Save as Draft button** — when writing a new comment or reply, a "Save as Draft" button appears alongside "Submit Comment". Drafts are saved locally and not posted to AzDO.
  - **Draft visibility** — draft comments appear in the VS Code Comments panel and in the sidebar tree view under their respective files with a 📝 Draft label.
  - **Edit and update drafts** — draft comments (including AI drafts) can be edited. An "Update Draft" button saves changes without posting.
  - **Post or dismiss** — each draft has "Post" (cloud-upload) and "Dismiss" (close) buttons in the thread title bar.
  - **Reply drafts** — save a reply as a draft on an existing AzDO thread.
  - **AI draft support** — AI review drafts now also show in the sidebar tree view and support the "Update Draft" button.
  - **Draft persistence** — enable `vscode-pr-azdo.persistDraftComments` in settings to preserve drafts across VS Code restarts, scoped per PR.
- **Toggle File / Diff view from comments** — when viewing a file opened from a PR comment, a new `$(git-compare)` button appears in the editor title bar to switch to the diff view for that file. From the diff view, clicking the button switches back to the file view. Cursor position is preserved across toggles. The button only appears for files belonging to the active pull request.

### Fixed

- **Auto-recovery from authorization errors** — when the extension encounters a `TF400813` (or other auth) error during normal operation (e.g. fetching PRs, loading threads), it now automatically clears the tenant cache, resets the connection, and rebuilds the API client. Previously this required manually running the "Clear Auth Cache" command. A 30-second cooldown prevents rapid rebuild loops.
- **Reply drafts preserved across thread refreshes** — editing a reply draft no longer causes it to disappear from the thread and orphan in the sidebar. Draft text and context are now stored separately and re-applied after AzDO thread data refreshes.
- **Reactivate button hidden on active comments** — the "Reactivate" context menu item now only appears on resolved/closed/fixed threads, not on already-active ones. Conversely, "Resolve", "Won't Fix", and "Close" are hidden on inactive threads.

## [0.0.9]

### Fixed

- **Comment threads no longer reset after posting** — submitting a new comment or reply no longer causes all comment threads to briefly disappear and re-expand. Existing threads are updated in-place, preserving collapsed/expanded state and reading context.

## [0.0.8]

### Fixed

- **Git worktree support** — checkout, comments, diffs, and AI review now target the correct worktree directory instead of always using the first repository. The extension detects which repository contains the Azure DevOps remote and uses that for all operations.

### Added

- **Multi-tenant authentication support** — when your Microsoft account belongs to multiple Entra tenants, the extension now automatically discovers the correct tenant for the Azure DevOps organization and re-authenticates with a tenant-specific token. Previously the extension would silently use a cached session for the wrong tenant, causing `TF400813` authorization errors.
- **Automatic tenant discovery** — on auth failure, the extension queries the AzDO org's `_apis/connectionData` and `_apis/projects` endpoints to extract the org's tenant ID from response headers (`X-VSS-ResourceTenant`, `WWW-Authenticate`)
- **Tenant cache** — discovered org-to-tenant mappings are persisted in global state so subsequent connections skip the discovery step
- **Switch Account command** — new "Azure DevOps PR: Switch Account / Tenant" command forces a fresh login with `forceNewSession` + `clearSessionPreference`, useful when the wrong tenant is cached
- **Clear Auth Cache command** — new "Azure DevOps PR: Clear Auth Cache" command wipes the tenant cache and resets the API connection for testing or troubleshooting
- **Actionable error notifications** — tenant mismatch errors now show a notification with a "Switch Account" button instead of failing silently
- **Connection mutex** — concurrent API callers share a single in-flight connection attempt instead of each triggering separate discovery flows

## [0.0.7]

### Added

- **Tool limit** — tools sent to the LM are capped at 128; a warning notification is shown if any are dropped
- **Skip dirty checkout prompt** — new setting `vscode-pr-azdo.skipDirtyCheckoutPrompt` (default: off) skips the dirty working tree warning and proceeds as "Try Anyway"
- **Auto-expand files on PR open** — the Active PR tree automatically expands all files when a new PR is detected
- **Auto-delete branch on PR switch** — new setting `vscode-pr-azdo.autoDeleteBranchOnSwitch` (default: off) automatically deletes the local branch when checking out a different PR; only applies to branches checked out via the extension
- **Reset filters on PR change** — new setting `vscode-pr-azdo.resetFiltersOnPrChange` (default: off) resets comment filters to "Active Comments" and "All Authors" when switching to a different pull request
- **Expand All beside Collapse All** — the expand-all button now renders next to the built-in collapse-all button in the Active PR view title bar

## [0.0.6]

### Added

- **Copilot instruction file support** — all AI prompts (`/fix`, `/review`, `/review-quick`, `/review-branch`, and PR description generation) now instruct the LM to search for and read user instruction files before responding: `.github/copilot-instructions.md` (repo-level), `**/.instructions.md` (directory-scoped), and `.copilot/` directory contents
- **Context-aware review mode selection** — "Review with Copilot" and "Standalone Review" now detect your git working tree state and offer appropriate review scopes:
  - **Clean + pushed** — auto-proceeds with diff against the remote target branch (previous behavior)
  - **Clean + unpushed commits** — choose between reviewing only unpushed commits or all changes vs the remote target
  - **Dirty working tree** — choose from staged changes only, unstaged changes only, all uncommitted changes vs last commit, committed but non-pushed changes, or everything vs the remote target
- **Review mode passed to AI** — the chat participant now shows what scope of changes it is reviewing in progress messages and context sent to the language model
- **Inline reply drafts** — "Post Reply to Thread" now prefills the AI-suggested reply as an editable comment directly in the inline thread instead of a small input box; edit in place and submit or dismiss with the familiar checkmark/dismiss buttons
- **Vote-based grouping in Waiting for My Review** — PRs awaiting your review are now grouped by your vote status (No vote yet, Waiting for author, Approved with suggestions, Approved, Rejected) so you can quickly find PRs that still need attention
- **Double-click to checkout** — double-click a PR in the Pull Requests tree to checkout its branch; single click still opens the detail webview
- **Checkout from webview** — the PR detail panel now includes a “Checkout Branch” button alongside Approve, Reject, and Open in Browser
- **Dirty checkout handling** — checking out a PR branch on a dirty working tree now shows a clear warning with options to Stash & Checkout, Try Anyway, or Cancel

## [0.0.5]

### Fixed

- **Expand All now fully recursive** — the expand-all button properly expands every nested folder in the tree, not just the top levels
- **getParent support** — tree data provider now tracks parent–child relationships, enabling reliable `reveal()` at any depth

## [0.0.4]

### Fixed

- **Editable AI draft comments** — AI review drafts now appear in an editable textarea; edit the text and click the checkmark to post your revised comment to Azure DevOps
- **Draft submit posts edited text** — submitting from the reply box on a draft thread now sends the user's text instead of the original AI text

### Changed

- **Review prompt improvements** — AI review comments no longer praise or affirm code (e.g. "Good tests, but…"); comments are direct and to the point
- **Removed "Post Draft" title button** — replaced by the inline "Post Comment" checkmark in the editing area

## [0.0.3]

- **Expand All** — new button in the Active PR view title bar to expand the entire tree in one click
- **Concise review comments** — AI review prompt updated to produce shorter, non-repetitive comments

## [0.0.2]

### Added

- **Review mode toggle in tree view** — a prominent "Enable Review" / "Disable Review" item at the top of the Active PR view, making the review toggle discoverable without hunting for the eye icon in the title bar
- **Auto-enable review mode on checkout** — checking out a PR branch via the sidebar automatically turns on review mode
- **Tree view description** — the Active PR view header shows "reviewing" when review mode is active

## [0.0.1]

- Initial release