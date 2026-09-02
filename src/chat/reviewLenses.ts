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