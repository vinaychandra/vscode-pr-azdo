# Azure DevOps PR — VS Code Extension

Review Azure DevOps pull requests directly inside VS Code. Browse PR files, view inline comments with suggestion diffs, reply, resolve threads, and see comments in their original context — all without leaving your editor.

## Features

### Pull Request Browser

- **All Open PRs** — browse all active pull requests in the repository
- **Created By Me** — filter to PRs you authored
- **Waiting for My Review** — see PRs assigned to you for review
- **Checkout** — one-click checkout of a PR's source branch

### Active Pull Request View

When you're on a branch with an open PR, the extension automatically detects it and shows:

- **File Changes** — folder tree of changed files with change type labels (Add, Edit, Delete, Rename)
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
- Direct link to the PR on Azure DevOps

## Requirements

- **VS Code** 1.110.0 or later
- **Git** — the VS Code built-in Git extension must be active
- A local clone of an **Azure DevOps** Git repository (supports `dev.azure.com` and `visualstudio.com` remotes, HTTPS and SSH)

### Authentication

The extension uses **Entra ID (Azure AD)** authentication via VS Code's built-in Microsoft authentication provider. Sign in via the Command Palette or the welcome view prompt.

## Extension Commands

| Command                                  | Description                                   |
| ---------------------------------------- | --------------------------------------------- |
| `Azure DevOps PR: Sign In`               | Authenticate with Azure DevOps                |
| `Azure DevOps PR: Show Detection Status` | Show detected org/project/repo                |
| `Azure DevOps PR: Verify API Connection` | Test API connectivity and list active PRs     |
| `Toggle Review Mode`                     | Show/hide comments and gutter icons           |
| `Filter Comments`                        | Switch between Active and All comment threads |
| `Refresh`                                | Re-fetch PR list or active PR data            |

## Known Issues

- Comments on deleted files show as empty in the original context diff
- The extension requires the repository to be fetched (`git fetch`) for original context diffs to resolve commit SHAs

## Release Notes

### 0.0.1

Initial development release:

- Azure DevOps remote detection (HTTPS + SSH, dev.azure.com + visualstudio.com)
- Entra ID authentication
- PR list with categories (All Open, Created By Me, Waiting for Review)
- Active PR detection by current branch
- File change tree with folder compaction
- Inline comments with suggestion diff rendering
- Comment replies, new threads, and thread status management
- Review mode toggle with persistence
- Comment filtering (Active / All)
- View Original Context — historical diff with comment placement
- PR detail webview
- One-click branch checkout
