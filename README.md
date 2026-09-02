# Azure DevOps PR — VS Code Extension

Review Azure DevOps pull requests directly inside VS Code. Browse PR files, view inline comments with suggestion diffs, reply, resolve threads, and see comments in their original context — all without leaving your editor.

## Features

### Pull Request Browser

- **All Open PRs** — browse all active pull requests in the repository
- **Created By Me** — filter to PRs you authored
- **Waiting for My Review** — see PRs assigned to you for review, grouped by your vote status (No vote yet, Approved, Waiting for author, etc.)
- **Review destination** — click the review action or double-click a PR, then choose the current repository, the reusable detached review worktree, or a no-checkout snapshot review
- **Author display** — PR author's first name shown alongside the PR number
- **Delete Branch** — remove the local branch after review from the Active PR sidebar

### Active Pull Request View

When you're on a branch with an open PR, or when you select **Review Without Checkout** for any PR, the extension shows:

- **File Changes** — folder tree of changed files with change type labels (Add, Edit, Delete, Rename)
- **Reviewed checkboxes** — tick files and folders as reviewed; folder ticks recursively mark all children; state persists per-PR
- **Commits** — list of commits in the PR
- **Comment Threads** — inline and PR-level comments attached to each file

### Review Without Checkout

Choose **Review Without Checkout** from the **Review Pull Request** picker to review a PR without switching branches or creating a worktree:

- Fetches the PR source and target commits into extension-owned Git refs
- Leaves the working tree, index, current branch, `HEAD`, and ordinary local branches unchanged
- Shows exact commit-to-commit diffs in read-only virtual documents
- Supports inline comments, drafts, replies, thread status changes, votes, reviewed-file checkboxes, suggestions, and AI review
- Remains pinned in the current VS Code window until you select another review or run **Stop No-Checkout Review**
- Refresh fetches the latest source and target commits while preserving the local checkout

Git object data and refs under `.git` are updated by the fetch. The selected no-checkout review is not restored after reloading VS Code.

### Inline Comments

- Comments appear as inline annotations on the exact lines they reference
- **Suggestion diffs** are rendered as rich `- / +` diffs showing the proposed change
- **Reply** to existing threads directly from the editor
- **New comments** — click the `+` gutter icon on any PR file to start a new thread
- **Draft comments** — click "Save as Draft" to save comments locally without posting to Azure DevOps; drafts appear in both the Comments panel and sidebar tree under their respective files; edit and update drafts before publishing; works for new comments and replies on existing threads
- **Draft persistence** — enable `persistDraftComments` in settings to preserve drafts across VS Code restarts
- **Thread status** — Resolve, Won't Fix, Close, or Reactivate threads from inline buttons
- **Non-disruptive updates** — posting a comment or reply updates threads incrementally without resetting collapsed/expanded state

### Review Mode

A **togglable review mode** keeps comments out of your way when you're not reviewing:

- **OFF (default)** — no inline comments, no `+` gutter icons, no distractions
- **ON** — full comment UI enabled
- Toggle via the status bar (`$(eye-closed) Review` / `$(eye) Reviewing`) or the tree view title button
- A **comment filter** (Active / All) lets you focus on unresolved threads or see everything
- Review mode state persists across VS Code restarts (per-workspace)

### View Original Context

When code has changed since a comment was made, click the **$(git-compare)** button in the comment thread title bar to open a diff showing the file exactly as it was at the time the comment was created:

- Uses the PR iteration's source and target commit SHAs for an accurate historical diff
- Places the comment (with fully rendered suggestion diffs) at its original line position
- Handles file renames and line tracking across iterations

### Diff Views

- **File diff** — compare any changed file against the target branch and either the working copy or the exact fetched PR source commit
- Supports Add, Delete, Edit, and Rename change types
- Git ref content is fetched via `git show` and cached for performance

### PR Detail Panel

- Webview showing PR metadata: title, description, author, reviewers with vote status, labels, work items, merge status, and auto-complete info
- **Review Pull Request** button to choose a current-repository, worktree, or no-checkout review from the detail panel
- Direct link to the PR on Azure DevOps

### AI Assistant (`@azdo-pr`)

A Copilot Chat participant that helps resolve PR comments and review code:

- **`/fix`** — analyze a comment thread and suggest a code fix, a reply, or both
- **`/explain`** — explain what a comment is asking for
- **`/review`** — full AI code review of all changed files with inline draft comments
- **`/review-quick`** — high-level summary of PR changes and key concerns
- **Context-aware review scope** — when your working tree is dirty or has unpushed commits, a QuickPick lets you choose exactly what to review: staged changes, unstaged changes, all uncommitted changes, unpushed commits only, or everything vs the remote target
- **Apply Suggestion** button — appears when the AI (or an AzDO suggestion block) proposes a code change; applying requires a current-repository or worktree checkout because it edits local files
- **Post Reply** button — post an AI-drafted reply directly to Azure DevOps; the reply is prefilled as an editable inline comment so you can review and edit it in context before posting
- Uses workspace tools for checked-out reviews and commit-backed read/search tools for no-checkout reviews
- **Honors Copilot instruction files** — automatically reads `.github/copilot-instructions.md`, `**/.instructions.md`, and `.copilot/` directory contents before responding, so your repo-level and directory-scoped coding guidelines are respected
- Customizable system prompts via settings (`vscode-pr-azdo.prompts.*`)

### Subfolder Workspace Support

- Works correctly when VS Code is opened on a subfolder of the git repository
- All file resolution (diffs, comments, AI context) uses the git repo root, not the workspace folder

### Git Worktree Support

- Works correctly with git worktrees — checkout, comments, diffs, and AI review all target the correct worktree directory
- Automatically detects which repository contains the Azure DevOps remote, rather than assuming `repositories[0]`
- In multi-root workspaces with both a main checkout and worktrees, operations target the matched repository
- Every checkout prompts for either the current repository or one reusable detached review worktree, so you can choose differently for each PR
- The default review path is `../${repo}.worktrees/review`, resolved from the primary repository root; customize it with `vscode-pr-azdo.reviewWorktreePath`
- Switching PRs reuses a clean review worktree without checking out the PR branch; a dirty review worktree is never replaced automatically
- The review worktree opens in a separate VS Code window, and reviewed-file checkboxes remain scoped to each PR

## Requirements

- **VS Code** 1.110.0 or later
- **Git** — the VS Code built-in Git extension must be active
- A local clone of an **Azure DevOps** Git repository (supports `dev.azure.com` and `visualstudio.com` remotes, HTTPS and SSH)

### Authentication

The extension uses **Entra ID (Azure AD)** authentication via VS Code's built-in Microsoft authentication provider. Sign in via the Command Palette or the welcome view prompt.

**Multi-tenant accounts:** If your Microsoft account belongs to multiple Entra tenants, the extension automatically discovers the correct tenant for the Azure DevOps organization and re-authenticates. If automatic discovery fails, use the "Switch Account / Tenant" command from the Command Palette to force a fresh login.

## Extension Commands

| Command                                    | Description                                          |
| ------------------------------------------ | ---------------------------------------------------- |
| `Azure DevOps PR: Sign In`                 | Authenticate with Azure DevOps                       |
| `Azure DevOps PR: Switch Account / Tenant` | Force re-authentication (multi-tenant scenarios)     |
| `Azure DevOps PR: Clear Auth Cache`        | Clear cached tenant mappings and reset connection    |
| `Azure DevOps PR: Show Detection Status`   | Show detected org/project/repo                       |
| `Azure DevOps PR: Verify API Connection`   | Test API connectivity and list active PRs            |
| `Toggle Review Mode`                       | Show/hide comments and gutter icons                  |
| `Filter Comments`                          | Switch between Active and All comment threads        |
| `Refresh`                                  | Re-fetch PR list or active PR data                   |
| `Review Pull Request`                      | Choose a checkout, worktree, or no-checkout review    |
| `Stop No-Checkout Review`                  | Return the Active PR view to current-branch detection |
| `Delete Local Branch`                      | Delete the checked-out PR branch (with force option) |
| `Review with Copilot`                      | Start an AI code review of the active PR             |
| `Azure DevOps PR: Reset AI Prompts`        | Reset custom AI prompts to defaults                  |
| `Azure DevOps PR: View Default Prompts`    | View the built-in system prompts                     |

## Known Issues

See [KnownIssues.md](KnownIssues.md) for the current list.

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for a full version history.
