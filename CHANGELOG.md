# Change Log

All notable changes to the "vscode-pr-azdo" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added

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