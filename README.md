# Azure DevOps PR — VS Code Extension

Review Azure DevOps pull requests directly inside VS Code. Browse PR files, view inline comments with suggestion diffs, reply, resolve threads, and see comments in their original context — all without leaving your editor.

## Features

### Pull Request Browser

- **All Open PRs** — browse all active pull requests in the repository
- **Created By Me** — filter to PRs you authored
- **Waiting for My Review** — see PRs assigned to you for review, grouped by your vote status (No vote yet, Approved, Waiting for author, etc.)
- **Checkout** — one-click checkout of a PR's source branch with progress notification, or double-click a PR in the tree to checkout directly; dirty working tree is detected upfront with Stash & Checkout option
- **Author display** — PR author's first name shown alongside the PR number
- **Delete Branch** — remove the local branch after review from the Active PR sidebar

### Active Pull Request View

When you're on a branch with an open PR, the extension automatically detects it and shows:

- **File Changes** — folder tree of changed files with change type labels (Add, Edit, Delete, Rename)
- **Reviewed checkboxes** — tick files and folders as reviewed; folder ticks recursively mark all children; state persists per-PR
- **Commits** — list of commits in the PR
- **Comment Threads** — inline and PR-level comments attached to each file

### Inline Comments

- Comments appear as inline annotations on the exact lines they reference
- **Suggestion diffs** are rendered as rich `- / +` diffs showing the proposed change
- **Reply** to existing threads directly from the editor
- **New comments** — click the `+` gutter icon on any PR file to start a new thread
- **Thread status** — Resolve, Won't Fix, Close, or Reactivate threads from inline buttons

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

- **File diff** — compare any changed file against the target branch (`origin/main ↔ Working Copy`)
- Supports Add, Delete, Edit, and Rename change types
- Git ref content is fetched via `git show` and cached for performance

### PR Detail Panel

- Webview showing PR metadata: title, description, author, reviewers with vote status, labels, work items, merge status, and auto-complete info
- **Checkout Branch** button to check out the PR’s source branch directly from the detail panel
- Direct link to the PR on Azure DevOps

### AI Assistant (`@azdo-pr`)

A Copilot Chat participant that helps resolve PR comments and review code:

- **`/fix`** — analyze a comment thread and suggest a code fix, a reply, or both
- **`/explain`** — explain what a comment is asking for
- **`/review`** — full AI code review of all changed files with inline draft comments
- **`/review-quick`** — high-level summary of PR changes and key concerns
- **Context-aware review scope** — when your working tree is dirty or has unpushed commits, a QuickPick lets you choose exactly what to review: staged changes, unstaged changes, all uncommitted changes, unpushed commits only, or everything vs the remote target
- **Apply Suggestion** button — appears when the AI (or an AzDO suggestion block) proposes a code change
- **Post Reply** button — post an AI-drafted reply directly to Azure DevOps; the reply is prefilled as an editable inline comment so you can review and edit it in context before posting
- Uses workspace tools to read files and search symbols before responding — no guessing
- **Honors Copilot instruction files** — automatically reads `.github/copilot-instructions.md`, `**/.instructions.md`, and `.copilot/` directory contents before responding, so your repo-level and directory-scoped coding guidelines are respected
- Customizable system prompts via settings (`vscode-pr-azdo.prompts.*`)

### Subfolder Workspace Support

- Works correctly when VS Code is opened on a subfolder of the git repository
- All file resolution (diffs, comments, AI context) uses the git repo root, not the workspace folder

## Requirements

- **VS Code** 1.110.0 or later
- **Git** — the VS Code built-in Git extension must be active
- A local clone of an **Azure DevOps** Git repository (supports `dev.azure.com` and `visualstudio.com` remotes, HTTPS and SSH)

### Authentication

The extension uses **Entra ID (Azure AD)** authentication via VS Code's built-in Microsoft authentication provider. Sign in via the Command Palette or the welcome view prompt.

## Extension Commands

| Command                                  | Description                                          |
| ---------------------------------------- | ---------------------------------------------------- |
| `Azure DevOps PR: Sign In`               | Authenticate with Azure DevOps                       |
| `Azure DevOps PR: Show Detection Status` | Show detected org/project/repo                       |
| `Azure DevOps PR: Verify API Connection` | Test API connectivity and list active PRs            |
| `Toggle Review Mode`                     | Show/hide comments and gutter icons                  |
| `Filter Comments`                        | Switch between Active and All comment threads        |
| `Refresh`                                | Re-fetch PR list or active PR data                   |
| `Checkout Branch`                        | Fetch and checkout a PR's source branch              |
| `Delete Local Branch`                    | Delete the checked-out PR branch (with force option) |
| `Review with Copilot`                    | Start an AI code review of the active PR             |
| `Azure DevOps PR: Reset AI Prompts`      | Reset custom AI prompts to defaults                  |
| `Azure DevOps PR: View Default Prompts`  | View the built-in system prompts                     |

## Known Issues

- Comments on deleted files show as empty in the original context diff
- The extension requires the repository to be fetched (`git fetch`) for original context diffs to resolve commit SHAs

## Release Notes

### 0.0.6

- **Expand All beside Collapse All** — the expand-all button now renders next to the built-in collapse-all button
- **Copilot instruction file support** — AI prompts now tell the LM to read `.github/copilot-instructions.md`, `.instructions.md` files, and `.copilot/` directory contents before responding, so repo-level and directory-scoped coding guidelines are honored
- **Context-aware review mode** — "Review with Copilot" and "Standalone Review" detect git state and offer scope options (staged, unstaged, uncommitted, unpushed, or vs target)
- **Inline reply drafts** — AI-suggested replies are prefilled as editable inline comments instead of a small input box
- **Vote-based grouping** — "Waiting for My Review" groups PRs by your vote status (No vote, Approved, Waiting for author, Rejected)
- **Double-click to checkout** — double-click a PR in the tree to checkout its branch; single click opens the detail webview
- **Checkout from webview** — PR detail panel includes a Checkout Branch button

### 0.0.5

- **Expand All fix** — the expand-all button now recursively expands every nested folder, not just the top levels

### 0.0.4

- **Editable AI draft comments** — AI review drafts appear in an editable textarea; edit and click the checkmark to post your revised comment
- **Draft submit fix** — submitting from the reply box on a draft now sends your text, not the original AI text
- **No-praise review prompt** — AI comments no longer start with affirmations like "Good tests, but…"
- **Simplified draft UX** — removed redundant "Post Draft" title button; inline "Post Comment" checkmark is the primary action

### 0.0.3

- **Expand All** — new button in the Active PR view title bar to expand the entire tree in one click (complements the built-in collapse-all)
- **Concise review comments** — AI review prompt tuned to produce shorter, non-repetitive comments

### 0.0.2

- **Review mode toggle in tree view** — "Enable Review" / "Disable Review" button at the top of the Active PR view with thread count, replacing the hidden eye icon as the primary toggle
- **Auto-enable review on checkout** — checking out a PR branch via the sidebar automatically enables review mode
- **Tree view description** — Active PR view header shows "reviewing" when review mode is on

### 0.0.1

Initial development release:

- Azure DevOps remote detection (HTTPS + SSH, dev.azure.com + visualstudio.com)
- Entra ID authentication
- PR list with categories (All Open, Created By Me, Waiting for Review) with author names
- Active PR detection by current branch
- File change tree with folder compaction
- Reviewed file checkboxes with folder-level recursive toggle (persisted per-PR)
- Inline comments with suggestion diff rendering
- Comment replies, new threads, and thread status management
- Review mode toggle with persistence
- Comment filtering (Active / All)
- View Original Context — historical diff with comment placement
- PR detail webview
- One-click branch checkout with progress indicator
- Delete local PR branch (safe delete with force option)
- AI assistant (`@azdo-pr`) with `/fix`, `/explain`, `/review`, `/review-quick` commands
- AI draft comments from `/review` posted inline on files
- Customizable AI prompts
- Multi-round tool use in AI chat (reads full files across multiple rounds)
- Subfolder workspace support (uses git repo root for all file resolution)
- Inline comments with suggestion diff rendering
- Comment replies, new threads, and thread status management
- Review mode toggle with persistence
- Comment filtering (Active / All)
- View Original Context — historical diff with comment placement
- PR detail webview
- One-click branch checkout
