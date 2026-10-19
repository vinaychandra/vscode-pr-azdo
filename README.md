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

You can also run **Review Pull Request from URL** without opening a folder or cloning the repository. For repository-free and external-repository reviews, the extension retrieves only the pull request's changed paths and selected source/comparison revisions through Azure DevOps APIs. It resolves all file versions in one batch request and downloads their unique blobs in one ZIP request; repository size does not affect the number of files downloaded.

For any active pull request, including a standard checkout or review worktree, select **Show Iterations** directly below the Review Mode toggle to choose one or more updates. Iterations are ordered newest first, with **Base** shown last as the common commit between the source and target branches. Selecting iteration 3 alone compares iteration 3 with iteration 2; selecting iterations 2 through 4 compares iteration 4 with iteration 1. If selected iterations contain gaps, the intermediate iterations are included automatically; selecting none falls back to the latest iteration. The Files tree, the currently open diff, and new comment metadata all follow the selected range. Iteration diffs use immutable Azure DevOps content and do not modify the current checkout or worktree.

File diffs are server-authoritative in every review mode. Opening a diff from a standard checkout or review worktree loads the pull request's immutable source and common-base revisions through Azure DevOps, so an outdated local `main`/`master`, remote-tracking branch, or PR branch does not alter the displayed review. The checkout remains unchanged and available for supported AI and fix actions.

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

### AI Reviews with the Copilot Harness

AI actions open a new **Copilot** harness session with the bundled **Azure DevOps Review** agent. The Local harness and the old `@azdo-pr` participant are no longer used. Your default harness and profile-wide tool selection are not changed.

The agent is restricted to this extension's review tools: reading the selected comparison, listing directories, searching specified files, creating editable local drafts, drafting replies, and proposing code fixes. It has no terminal, workspace-editing, publishing, voting, or thread-resolution tool.

- **Review with Copilot** — detailed review of the selected comparison, with structured findings returned as editable inline AI draft comments
- **Quick Review with Copilot** — high-level summary and concerns, without creating drafts or fixes
- **Resolve with Copilot** — analyze a thread in its original code context and draft a reply, propose a code fix, or both
- **Explain with Copilot** — explain a comment without creating drafts or changing files
- **Perform AI Review** — standalone branch review when no PR is active
- **Review Lenses** — every **Review with Copilot** run starts by choosing a focused review style: General, Bugs, Security, Architecture, Performance, or one of your custom lenses
- **Context-aware review scope** — when your working tree is dirty or has unpushed commits, a QuickPick lets you choose exactly what to review: staged changes, unstaged changes, all uncommitted changes, unpushed commits only, or everything vs the remote target
- **User-approved fixes** — a proposed fix offers **Preview AI Fix**, opens a diff, and requires explicit approval before applying. The original code must match exactly once; changed files and stale reviews are rejected. Fixes require the current repository or a review worktree. Applied changes remain normal editor changes for you to save.
- **Editable replies** — AI replies appear in their exact comment thread as local drafts. Review, edit, publish, or dismiss them using the normal comment controls. Existing reply drafts are not overwritten.
- **No-checkout and repository-free AI review** — reads exact Azure DevOps source/base revisions and can create inline review drafts and reply drafts without cloning or switching branches. Code fixes still require a checkout.
- **Historical and local-change accuracy** — findings retain their original side, range, commits, and iteration metadata, including after restoring persisted drafts. Staged/unpushed/working-tree findings open their captured code rather than an unrelated PR snapshot. These local-change drafts are not publishable: update the PR and review its published snapshot before posting.
- **Run isolation** — repository, PR, branch, and comparison changes invalidate old AI tool calls. Repeated findings are deduplicated. Review runs and unapplied fix proposals expire when the extension reloads.
- **Repository guidance** — the agent is instructed to inspect applicable `AGENTS.md`, `.github/copilot-instructions.md`, scoped `.instructions.md`, and `.copilot/` guidance through the review tools
- Customizable comment-resolution and quick-review prompts via settings (`vscode-pr-azdo.prompts.*`)

You can also select **Azure DevOps Review** in a Copilot session and ask it to review the active PR. The context tool can start a detailed or quick review with an optional scope and lens. Keep the editor window connected: extension tools and native comments are provided by that window, even if the Copilot session itself can continue in the background.

Directory listings and file reads can inspect surrounding repository code at the reviewed revision. Search defaults to changed source files, or searches explicitly supplied paths; it is not a repository-wide search. Read, directory, and search results report pagination instead of silently truncating.

If Copilot is unavailable, AI actions report an error rather than falling back to Local. Manual diffs, comments, drafts, replies, thread status changes, and votes remain independent of AI.

### Review Lenses

A review lens controls **how** Copilot inspects a change, independently from the review scope that controls **which** local changes are included:

- **General** — balanced correctness, security, reliability, performance, and maintainability review
- **Bugs** — logic errors, edge cases, races, invalid assumptions, and broken failure paths
- **Security** — trust boundaries, authorization, injection, secrets, and data exposure
- **Architecture** — ownership, coupling, contracts, extensibility, and maintainability
- **Performance** — complexity, repeated work, allocations, I/O, caching, and scalability

Choose **Create New Lens...** in the lens picker to create a reusable custom lens. Custom lenses are Markdown files stored in the extension's global storage and are available in every workspace. Use the Edit and Delete buttons beside a custom lens, or run **Azure DevOps PR: Manage Review Lenses** from the Command Palette.

Existing values from the deprecated `vscode-pr-azdo.prompts.review` setting are imported once as a **Migrated Review** custom lens. The extension always combines lens instructions with its structured output protocol, so custom lenses should describe review priorities rather than repeat the response format.

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
- **AI actions** require a VS Code build with the Copilot harness and extension-tool support (validated on 1.142.0), enabled Copilot Chat, model access, and the extension's review tools enabled
- **Git** — the VS Code built-in Git extension must be active
- An **Azure DevOps** Git repository or pull request URL (supports `dev.azure.com` and `visualstudio.com` remotes, HTTPS and SSH). A local clone is needed for local-change reviews and code fixes, not for repository-free PR reviews.

### Authentication

The extension uses **Entra ID (Azure AD)** authentication via VS Code's built-in Microsoft authentication provider. Sign in via the Command Palette or the welcome view prompt.

**Token expiry:** API requests silently reacquire a token through Microsoft's authentication provider and retry once when authorization expires. Concurrent requests share reconnection, and background refreshes never open sign-in dialogs or recurring expiry notifications. If silent renewal is unavailable (for example, MFA or revoked access), Sign In remains available in the panel; authentication becomes interactive only after an explicit sign-in, account-switch, or initial URL-review action.

**Multi-tenant accounts:** If your Microsoft account belongs to multiple Entra tenants, the extension automatically discovers the correct tenant for the Azure DevOps organization and first tries a cached tenant-scoped session silently. If that is unavailable, use Sign In or "Switch Account / Tenant" from the Command Palette to authenticate explicitly.

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
| `Review Pull Request from URL`             | Review a pasted PR; external repositories use no-checkout mode |
| `Stop No-Checkout Review`                  | Return the Active PR view to current-branch detection |
| `Delete Local Branch`                      | Delete the checked-out PR branch (with force option) |
| `Review with Copilot`                      | Start an AI code review of the active PR             |
| `Azure DevOps PR: Quick Review with Copilot` | Summarize the active PR without creating drafts      |
| `Azure DevOps PR: Preview AI Fix`           | Preview a proposed code fix before applying          |
| `Azure DevOps PR: Apply AI Fix`             | Preview and explicitly approve a proposed fix        |
| `Azure DevOps PR: Manage Review Lenses`    | Create, edit, or delete global custom review lenses  |
| `Azure DevOps PR: Reset AI Prompts`        | Reset custom AI prompts to defaults                  |
| `Azure DevOps PR: View Default Prompts`    | View the built-in system prompts                     |

## Copilot Harness Smoke Test

The opt-in Copilot smoke test uses a real model and can consume Copilot usage. It reviews only a synthetic, local-only repository under `.vscode-test/copilot/workspace`; that repository has no configured remotes. No Azure DevOps PR is created, no code is pushed, and no comment is published.

First prepare the isolated VS Code profile and sign into Copilot:

```sh
npm run test:copilot:signin
```

Close that window after signing in, then run:

```sh
npm run test:copilot
```

Approve the extension's review tools if prompted. The test opens an actual Copilot-harness review, waits for a model-generated inline draft on the deliberately defective code, opens the native captured-code document, and verifies that HEAD, branch/remote/tag refs, staged content, and the working file are unchanged. Copilot can create its own local checkpoints under `refs/agents`; these harness-owned refs are reported separately. Results are recorded under `.vscode-test/copilot`. The runner refuses to reset a modified fixture or use one with configured remotes.

## Live Azure DevOps Tests

Live integration tests are opt-in and target only [E2ETestRepo](https://dev.azure.com/vinaychandra/Personal/_git/E2ETestRepo). They are not included in `npm test` and do not use Playwright.

For the first run, or after authentication expires:

```sh
npm run test:live:signin
```

In the new development VS Code window, run **Azure DevOps PR: Sign In**, complete Microsoft authentication, then close that window. This uses a separate profile under `.vscode-test/live`, not your normal profile. Interactive sign-in happens outside VS Code's extension-test mode because that mode refuses authentication dialogs.

Run the suite with:

```sh
npm run test:live
```

The runner builds the extension, opens a pinned VS Code development host, runs Mocha assertions, closes the test window, and returns a nonzero exit code on failure. It exercises real extension commands and verifies their results independently through Azure DevOps HTTP APIs:

- Opens a real draft PR and selects historical and iteration-to-iteration comparisons.
- Publishes user and seeded AI drafts and verifies path, side, position, change tracking, and iteration metadata.
- Checks actual text under inline comments after inserted lines, a deletion, and a server-recognized rename.
- Verifies original comment context, replies, and thread resolution.
- Abandons the PR and removes only run-owned branches, then verifies cleanup through HTTP.

Each run creates unique `azdo-live/run-*` branches and files under `.azdo-live/run-*`. An empty repository is initialized with a permanent `main` README; an existing default branch is not modified. Abandoned PRs remain as an audit trail. Results and ownership ledgers are saved under `.vscode-test/live/results`; credentials are never written to those files. Interrupted runs are recovered only after validating their recorded repository, PR refs, and commit IDs. Cleanup refuses to delete a branch changed outside the recorded run.

This suite feeds seeded findings through the Copilot review service to test draft creation, deduplication, and publishing without calling a model. Use `test:copilot` for real Copilot generation and harness coverage. Visual rendering, checkout/worktree flows, and full restart persistence still need separate smoke tests. Close the isolated sign-in/test window before starting another run.

## Known Issues

See [KnownIssues.md](KnownIssues.md) for the current list.

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for a full version history.
