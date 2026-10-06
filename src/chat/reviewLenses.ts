import * as vscode from 'vscode';

export interface ReviewLens {
    id: string;
    name: string;
    description: string;
    prompt: string;
    builtIn: boolean;
}

export const BUILT_IN_REVIEW_LENSES: readonly ReviewLens[] = [
    {
        id: 'general',
        name: 'General',
        description: 'Balanced review across correctness, security, performance, and clarity',
        prompt: `Review the change holistically. Prioritize, in order:
1. Bugs and logic errors, including edge cases and races
2. Security, authorization, injection, and data exposure
3. Error handling and reliability
4. Performance and unnecessary resource use
5. API misuse, maintainability, and clarity`,
        builtIn: true,
    },
    {
        id: 'bugs',
        name: 'Bugs',
        description: 'Logic errors, edge cases, races, and failure handling',
        prompt: `Focus on defects that can produce incorrect behavior. Trace control flow and state changes, and look for:
- Incorrect conditions, stale state, off-by-one errors, and invalid assumptions
- Missing edge cases, concurrency hazards, and ordering bugs
- Error paths that corrupt state, hide failures, or produce misleading results
- Regressions against existing behavior and contracts`,
        builtIn: true,
    },
    {
        id: 'security',
        name: 'Security',
        description: 'Trust boundaries, authorization, injection, secrets, and data exposure',
        prompt: `Focus on exploitable security and privacy risks. Examine:
- Authentication and authorization boundaries
- Injection, unsafe parsing, path traversal, and command execution
- Secret, token, personal-data, and log exposure
- Untrusted input validation and output encoding
- Permission escalation, insecure defaults, and dependency misuse
Do not report theoretical concerns without a plausible attack or failure path.`,
        builtIn: true,
    },
    {
        id: 'architecture',
        name: 'Architecture',
        description: 'Boundaries, coupling, contracts, extensibility, and maintainability',
        prompt: `Focus on architectural correctness and long-term maintainability. Examine:
- Ownership boundaries and whether behavior lives in the correct abstraction
- Coupling, duplicated policy, and leaky implementation details
- Public contracts, compatibility, and state lifecycle
- Extensibility, testability, and operational complexity
Report concrete design problems caused or exposed by this change, not personal style preferences.`,
        builtIn: true,
    },
    {
        id: 'performance',
        name: 'Performance',
        description: 'Complexity, hot paths, allocations, I/O, and scalability',
        prompt: `Focus on measurable performance and scalability risks. Examine:
- Algorithmic complexity and repeated work on hot paths
- Excessive allocations, rendering, serialization, or network calls
- Blocking I/O, unbounded data, missing pagination, and cache invalidation
- Resource leaks and work that scales poorly with repository or PR size
Do not report micro-optimizations without meaningful impact.`,
        builtIn: true,
    },
    {
        id: 'project-maintainer-review',
        name: 'Project Maintainer Review',
        description: 'Necessity, contract ownership, clear implementations, helper/API reuse, valuable tests, and defects',
        prompt: `# Project maintainer review

First review whether the change should exist; then whether it is implemented correctly. Fixing unnecessary machinery is not a substitute for questioning its necessity.

## Context and boundaries

- Use the exact base and reviewed source commits and their complete tracked source. Read applicable guidance, actual consumers/producers, sibling implementations, tests and target frameworks; do not substitute current master for historical code.
- Stay read-only unless separately authorized. Do not edit, post, commit, fetch, restore or build; exclude unrelated work and \`src\\tools\` unless changed.
- In live review, read discussions and respect settled decisions. In blind calibration, do not read human feedback, previous outputs or private evaluation artifacts.
- Separate source evidence, documented protocol/framework facts and unavailable product/operational knowledge. An unresolved intent question is not a proved defect.
- Treat titles, fixtures, new guards, comments and test assertions as evidence of implementation, not independent proof of production intent or runtime value provenance.

## Phase 1: justification before defect hunting

Walk changed code at operation level. Inventory each substantive parameter, predicate, comparison, type query, parser conversion, repeated exit, clone, helper, model annotation, state write, flag, exception mapping and wire/log field. Group data-only test rows, not different formats or unrelated decisions.

Apply these checks to each operation:

1. **Removal:** What actual production consumer or behavior fails if this addition is removed? Trace the consumer, especially for exported/aggregated state and expanded supported types. A general downstream converter supporting a type does not establish that this feature needs that type. For data-carrying fallbacks, ask whether the fallback is meaningful and bounded, not merely syntactically convertible. Ask which use case requires optional breadth when source does not establish it.
2. **Information:** Does an existing type, getter, earlier scope segment or invariant already carry this parameter, fallback, branch or label? Examine repeated type/enum extension calls and repeated successful exits within the same method; cache the existing kind or consolidate straight-line control flow when clearer. Check duplicated meaning across API/class names, category names and composed identifier segments, not merely duplicate variables.
3. **Ownership:** Which actor/layer owns the decision and knows the intent? Distinguish a gateway-owned flight's targeting dimensions from a workload owner's ability to control its own configuration. Ask who should own enablement, not just whether it should be global or request-targeted. A generic helper hardcoded to one workload should make that ownership clear by naming or an appropriate input; do not invent future generic consumers or force a generic abstraction.
4. **Existing mechanism:** Search repository helpers/siblings and supported framework/library APIs for the specific operation. Verify target frameworks. Absence of a built-in for an entire task does not justify hand-coding a suboperation such as byte conversion. Trace companion generators/parsers and cross-cutting utility placement. A small built-in or straight-line alternative can improve clarity without a measured performance regression; do not promise speed without evidence.
5. **Contract:** Check the actual wire/schema format, not merely what the CLR accepts. Consider lexical forms, timezone/default assumptions and nullability; separate whole-value from element behavior. If the authoritative contract is unavailable, ask the specific congruence question. If it already answers the question, record the reason rather than invent doubt.
6. **Producer/lifecycle:** Follow assignments and transformations in execution order to the predicate or consumer. A fake ID used to look up configuration is not automatically a possible dispatch-time value; a fixture containing it is not a production producer. Establish whether prefix/case/alternate-shape tolerance is needed at this exact point. Reject cheap invalid cases before allocation/conversion and explain rather than assume exceptions.

Do not suppress supported simplifications because they are non-blocking or small. Do not manufacture concerns when source or an authoritative contract establishes a clear reason.

## Phase 2: execution, cost and test fit

- Trace ownership through JSON cloning, merge, replacement and serialization; avoid redoing work on an owned value. Identify what unchanged writes validate and why computed state is discarded.
- Trace batch, child, fork, duplicate, retry, redirect and proxy paths before removing apparently duplicated protection or declaring an exclusion intentional.
- Check malformed shapes, protocol compatibility, exception behavior, conditional-value provenance and customer-actionable responses. Preserve genuine async/policy boundaries when consumers establish their need.
- Check per-request/item work, string/builder reuse, serialized-byte headroom, telemetry frequency/cardinality/retention and explicit truncation/loss. Bounded does not imply economical; keep PII/free-form values out of internal telemetry.
- Establish each test's distinct production decision; reuse repository fixtures, consolidate data-only variants and duplicate coverage, and avoid tests that enshrine incidental/undesirable behavior. Check enabled observable flows, not only constants/mocks/default-disabled paths.
- Document non-obvious rationale, not boilerplate. A precise question can request rationale without demanding a code change.
- Before concluding, revisit operations justified only as "needed for the feature," "the converter supports it," "fixtures contain it" or "no whole-task API exists." Replace those with the actual consumer/producer/operation-level reason, or a finding.

## Questions and output

- Ask when a consequential visible choice lacks an established purpose, owner or contract. Identify the concrete choice and consequence, the source inspected and the missing fact. Do not assert an unavailable external contract is broken.
- Write concise human-facing comments: "Why does X need Y? Z already carries it," "Which consumer requires this?" or "Can this owner control it in its own configuration?" Keep independent concerns at useful source anchors rather than hiding them in a broad omnibus comment.
- Include concrete improvements and questions without a runtime-bug, consensus or comment-quota gate. Adjudicate blockers separately.
- Keep confidence, assumptions and source/spec/intent classifications in the audit. Do not imitate personal mannerisms, frustration or sarcasm.
- Provide a calibration ledger: source anchor, operation, actual inspected consumer/producer or existing mechanism, and justified reason or finding ID. Whole-component rows do not cover independent local operations. New assertions or explicit guards alone are not reasons.
- For a potentially breaking identifier or protocol change, ask whether consumers/rollout permit it; do not demand a rename without checking compatibility.
- If source or specification resolves a possible question, record the answer instead of forcing agreement with a human reviewer.
- If delegating, use a general-purpose maintainer reviewer with explicit reviewed roots/diffs and no nested agents.`,
        builtIn: true,
    },
] as const;

export const REVIEW_PROTOCOL_PROMPT = `You are an expert code reviewer reviewing a pull request on Azure DevOps.

## Input
You will receive a unified diff (git diff output) of the changed files. The diff uses standard format:
- Lines starting with \`---\` and \`+++\` show the old and new file paths
- \`@@ -oldStart,oldCount +newStart,newCount @@\` marks each changed hunk
- Lines starting with \`-\` were removed, \`+\` were added, space means unchanged context
- Use the NEW file line numbers (the \`+\` side / right side of the hunk header) for your comments

## Tools
Use the available code-reading and search tools before commenting:
- Look up types, interfaces, or functions referenced in the diff
- Check imports, dependencies, and related call sites when needed
- Do not guess about code you have not inspected

## Output Format
For EACH review comment, use this EXACT format:

[REVIEW_COMMENT]
file: <relative path, NO leading slash, e.g. src/utils.ts>
line: <line number in the NEW file, from the + side of the diff>
type: <suggestion|issue|nitpick|question>
---
Your review comment here.
[/REVIEW_COMMENT]

## User Instructions
Before reviewing, search for and follow applicable instruction files:
- \`.github/copilot-instructions.md\`
- \`**/.instructions.md\`
- Files under \`.copilot/\`

## Rules
- Be terse. Each comment should be 1-3 sentences that state the problem and the fix.
- Do not praise the code or add filler.
- Do not repeat code back in prose or restate the type label.
- Do not comment on trivial style, formatting, or whitespace.
- If suggesting a fix, show only the corrected code.
- Do not force comments when the change is correct.
- After all comments, provide a brief 2-3 sentence summary of the change and assessment.`;

export function getBuiltInReviewLens(id: string | undefined): ReviewLens | undefined {
    return BUILT_IN_REVIEW_LENSES.find(lens => lens.id === id);
}

export function buildReviewPrompt(lens: ReviewLens): string {
    return `${REVIEW_PROTOCOL_PROMPT}\n\n## Review Lens: ${lens.name}\n${lens.prompt.trim()}`;
}

export function buildReviewChatQuery(lensId: string, mode?: string): string {
    const modeArgument = mode ? ` --mode=${mode}` : '';
    return `@azdo-pr /review --lens=${encodeURIComponent(lensId)}${modeArgument}`;
}

interface ReviewLensQuickPickItem extends vscode.QuickPickItem {
    lens?: ReviewLens;
    action?: 'create';
}

const CUSTOM_LENS_PREFIX = 'custom:';
const LENS_FOLDER = 'review-lenses';
const LEGACY_MIGRATION_KEY = 'reviewLensMigratedLegacyPrompt';
const EDIT_BUTTON: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('edit'),
    tooltip: 'Edit Lens',
};
const DELETE_BUTTON: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('trash'),
    tooltip: 'Delete Lens',
};

export function validateReviewLensName(name: string, existingNames: readonly string[] = []): string | undefined {
    const trimmed = name.trim();
    if (!trimmed) { return 'Enter a lens name.'; }
    if (trimmed.length > 80) { return 'Lens names must be 80 characters or fewer.'; }
    if (/[<>:"/\\|?*\x00-\x1f]/.test(trimmed) || /[. ]$/.test(trimmed)) {
        return 'Lens names cannot contain Windows-invalid filename characters or end with a period or space.';
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(trimmed)) {
        return 'Choose a different lens name; that name is reserved by Windows.';
    }
    if (BUILT_IN_REVIEW_LENSES.some(lens => lens.name.localeCompare(trimmed, undefined, { sensitivity: 'accent' }) === 0)
        || existingNames.some(existing => existing.localeCompare(trimmed, undefined, { sensitivity: 'accent' }) === 0)) {
        return 'A review lens with that name already exists.';
    }
    return undefined;
}

export class ReviewLensService {
    private readonly lensFolder: vscode.Uri;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly log: vscode.OutputChannel,
    ) {
        this.lensFolder = vscode.Uri.joinPath(context.globalStorageUri, LENS_FOLDER);
    }

    async initialize(): Promise<void> {
        await vscode.workspace.fs.createDirectory(this.lensFolder);
        await this.migrateLegacyReviewPrompt();
    }

    async listLenses(): Promise<ReviewLens[]> {
        const custom = await this.listCustomLenses();
        return [...BUILT_IN_REVIEW_LENSES, ...custom];
    }

    async resolveLens(id: string | undefined): Promise<ReviewLens | undefined> {
        if (!id) { return getBuiltInReviewLens('general'); }
        const builtIn = getBuiltInReviewLens(id);
        if (builtIn) { return builtIn; }
        if (!id.startsWith(CUSTOM_LENS_PREFIX)) { return undefined; }
        const fileName = id.substring(CUSTOM_LENS_PREFIX.length);
        if (!this.isSafeLensFileName(fileName)) { return undefined; }
        const uri = vscode.Uri.joinPath(this.lensFolder, fileName);
        try {
            const prompt = await this.readText(uri);
            if (!prompt.trim()) { return undefined; }
            return this.customLens(uri, prompt);
        } catch {
            return undefined;
        }
    }

    async chooseLens(manage = false): Promise<ReviewLens | undefined> {
        const picker = vscode.window.createQuickPick<ReviewLensQuickPickItem>();
        picker.title = manage ? 'Manage Review Lenses' : 'Choose Review Lens';
        picker.placeholder = manage
            ? 'Select a custom lens to edit, or use its delete button'
            : 'Choose how Copilot should review this change';
        picker.matchOnDescription = true;
        picker.matchOnDetail = true;

        return new Promise<ReviewLens | undefined>(resolve => {
            let settled = false;
            const finish = (lens?: ReviewLens) => {
                if (settled) { return; }
                settled = true;
                picker.hide();
                picker.dispose();
                resolve(lens);
            };
            const refresh = async () => {
                picker.busy = true;
                picker.items = this.toQuickPickItems(await this.listLenses());
                picker.busy = false;
            };

            picker.onDidAccept(() => {
                const selected = picker.selectedItems[0];
                if (!selected) { return; }
                if (selected.action === 'create') {
                    finish();
                    void this.createLens();
                    return;
                }
                if (manage) {
                    finish();
                    if (selected.lens?.builtIn) {
                        void vscode.window.showInformationMessage('Built-in review lenses cannot be edited.');
                    } else if (selected.lens) {
                        void this.openLens(selected.lens);
                    }
                    return;
                }
                finish(selected.lens);
            });
            picker.onDidTriggerItemButton(async event => {
                const lens = event.item.lens;
                if (!lens || lens.builtIn) { return; }
                if (event.button === EDIT_BUTTON) {
                    finish();
                    await this.openLens(lens);
                    return;
                }
                if (event.button === DELETE_BUTTON) {
                    const deleted = await this.deleteLens(lens);
                    if (deleted && !settled) { await refresh(); }
                }
            });
            picker.onDidHide(() => finish());
            void refresh().then(() => picker.show());
        });
    }

    async createLens(): Promise<void> {
        const existing = (await this.listCustomLenses()).map(lens => lens.name);
        const name = await vscode.window.showInputBox({
            title: 'Create Review Lens',
            prompt: 'Name this review lens',
            validateInput: value => validateReviewLensName(value, existing),
        });
        if (!name) { return; }
        const trimmed = name.trim();
        const validation = validateReviewLensName(trimmed, existing);
        if (validation) {
            void vscode.window.showErrorMessage(validation);
            return;
        }
        const uri = vscode.Uri.joinPath(this.lensFolder, `${trimmed}.md`);
        const starter = `Describe what Copilot should focus on for the ${trimmed} review lens.\n`;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(starter, 'utf-8'));
        await this.openUri(uri);
        void vscode.window.showInformationMessage('Edit and save the lens, then run Review with Copilot again.');
    }

    private async listCustomLenses(): Promise<ReviewLens[]> {
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(this.lensFolder);
        } catch {
            return [];
        }
        const lenses: ReviewLens[] = [];
        for (const [fileName, type] of entries) {
            if (type !== vscode.FileType.File || !this.isSafeLensFileName(fileName)) { continue; }
            const uri = vscode.Uri.joinPath(this.lensFolder, fileName);
            try {
                const prompt = await this.readText(uri);
                if (prompt.trim()) { lenses.push(this.customLens(uri, prompt)); }
            } catch (err) {
                this.log.appendLine(`[review-lens] Failed to read ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return lenses.sort((a, b) => a.name.localeCompare(b.name));
    }

    private toQuickPickItems(lenses: ReviewLens[]): ReviewLensQuickPickItem[] {
        const items: ReviewLensQuickPickItem[] = lenses.map(lens => ({
            label: lens.builtIn ? `$(search) ${lens.name}` : `$(file-text) ${lens.name}`,
            description: lens.description,
            detail: lens.builtIn ? 'Built-in lens' : 'Custom lens',
            buttons: lens.builtIn ? undefined : [EDIT_BUTTON, DELETE_BUTTON],
            lens,
        }));
        items.push({
            label: '$(add) Create New Lens...',
            description: 'Create a reusable Markdown prompt',
            action: 'create',
            alwaysShow: true,
        });
        return items;
    }

    private async openLens(lens: ReviewLens): Promise<void> {
        if (!lens.id.startsWith(CUSTOM_LENS_PREFIX)) { return; }
        const fileName = lens.id.substring(CUSTOM_LENS_PREFIX.length);
        if (this.isSafeLensFileName(fileName)) {
            await this.openUri(vscode.Uri.joinPath(this.lensFolder, fileName));
        }
    }

    private async deleteLens(lens: ReviewLens): Promise<boolean> {
        const confirmed = await vscode.window.showWarningMessage(
            `Delete the custom review lens "${lens.name}"?`,
            { modal: true },
            'Delete',
        );
        if (confirmed !== 'Delete') { return false; }
        const fileName = lens.id.substring(CUSTOM_LENS_PREFIX.length);
        if (!this.isSafeLensFileName(fileName)) { return false; }
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.lensFolder, fileName));
        return true;
    }

    private customLens(uri: vscode.Uri, prompt: string): ReviewLens {
        const fileName = uri.path.split('/').pop()!;
        return {
            id: `${CUSTOM_LENS_PREFIX}${fileName}`,
            name: fileName.substring(0, fileName.length - 3),
            description: 'Custom review instructions',
            prompt,
            builtIn: false,
        };
    }

    private isSafeLensFileName(fileName: string): boolean {
        return !fileName.includes('/')
            && !fileName.includes('\\')
            && fileName.toLowerCase().endsWith('.md')
            && !validateReviewLensName(fileName.substring(0, fileName.length - 3));
    }

    private async readText(uri: vscode.Uri): Promise<string> {
        const openDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
        if (openDocument) { return openDocument.getText(); }
        return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
    }

    private async openUri(uri: vscode.Uri): Promise<void> {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false });
    }

    private async migrateLegacyReviewPrompt(): Promise<void> {
        const config = vscode.workspace.getConfiguration('vscode-pr-azdo.prompts');
        const legacy = config.get<string>('review', '');
        if (!legacy.trim()) { return; }
        if (this.context.globalState.get<string>(LEGACY_MIGRATION_KEY) === legacy) { return; }
        const existingNames = (await this.listCustomLenses()).map(lens => lens.name);
        let name = 'Migrated Review';
        let suffix = 2;
        while (validateReviewLensName(name, existingNames)) {
            name = `Migrated Review ${suffix++}`;
        }
        const uri = vscode.Uri.joinPath(this.lensFolder, `${name}.md`);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(legacy, 'utf-8'));
        const inspected = config.inspect<string>('review');
        await this.context.globalState.update(LEGACY_MIGRATION_KEY, legacy);
        const hasWorkspaceOverride = inspected?.workspaceValue !== undefined
            || inspected?.workspaceFolderValue !== undefined;
        if (!hasWorkspaceOverride && inspected?.globalValue !== undefined) {
            await config.update('review', undefined, vscode.ConfigurationTarget.Global);
        }
        this.log.appendLine(`[review-lens] Migrated the legacy review prompt to ${name}.md`);
    }
}