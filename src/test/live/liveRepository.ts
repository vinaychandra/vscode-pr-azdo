import * as assert from 'assert';
import { randomUUID } from 'crypto';
import { writeFileSync, readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { setTimeout as delay } from 'timers/promises';
import type { GitPullRequestCommentThread, GitPullRequestIteration } from 'azure-devops-node-api/interfaces/GitInterfaces';

const repositoryApi = 'https://dev.azure.com/vinaychandra/Personal/_apis/git/repositories/E2ETestRepo';
const zeroId = '0'.repeat(40);

interface Ref { name: string; objectId: string }
interface RefResult { name: string; success: boolean; updateStatus: string }
interface Change {
    changeType: 'add' | 'edit' | 'delete' | 'rename';
    item: { path: string };
    sourceServerItem?: string;
    newContent?: { content: string; contentType: 'rawtext' };
}
export type RestThread = Omit<GitPullRequestCommentThread, 'status'> & { status?: string };

export async function waitFor<Value>(
    description: string,
    read: () => Promise<Value>,
    ready: (value: Value) => boolean,
    timeout = 30000,
): Promise<Value> {
    const deadline = Date.now() + timeout;
    do {
        const value = await read();
        if (ready(value)) { return value; }
        await delay(250);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${description}.`);
}

export class LiveRepository {
    readonly runId: string;
    get directory(): string { return `/.azdo-live/${this.runId}`; }
    get filePath(): string { return `${this.directory}/review.ts`; }
    get renamedPath(): string { return `${this.directory}/renamed.ts`; }
    get deletedPath(): string { return `${this.directory}/removed.ts`; }
    get baseRef(): string { return `refs/heads/azdo-live/${this.runId}/base`; }
    get sourceRef(): string { return `refs/heads/azdo-live/${this.runId}/source`; }
    readonly checks: string[] = [];
    pullRequestId: number | undefined;
    private readonly refs = new Map<string, string>();
    private readonly ledgerPath: string;

    constructor(private readonly getToken: () => Promise<string | undefined>, runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`) {
        assert.strictEqual(process.env.AZDO_LIVE_TESTS, '1');
        assert.ok(process.env.AZDO_LIVE_RESULT);
        assert.match(runId, /^run-\d+-[a-f0-9]{8}$/);
        this.runId = runId;
        this.ledgerPath = join(dirname(process.env.AZDO_LIVE_RESULT), `${runId}.json`);
    }

    static async recoverUnfinished(getToken: () => Promise<string | undefined>): Promise<void> {
        const results = dirname(process.env.AZDO_LIVE_RESULT!);
        for (const name of readdirSync(results).filter(name => /^run-\d+-[a-f0-9]{8}\.json$/.test(name))) {
            const saved = JSON.parse(readFileSync(join(results, name), 'utf-8')) as {
                repository: string; runId: string; pullRequestId?: number; refs: Record<string, string>; state: string;
            };
            if (saved.state === 'cleaned') { continue; }
            assert.strictEqual(saved.repository, 'vinaychandra/Personal/E2ETestRepo');
            assert.strictEqual(name, `${saved.runId}.json`);
            const fixture = new LiveRepository(getToken, saved.runId);
            for (const [ref, commit] of Object.entries(saved.refs)) {
                assert.ok(ref === fixture.baseRef || ref === fixture.sourceRef);
                assert.match(commit, /^[a-f0-9]{40}$/i);
                fixture.refs.set(ref, commit);
            }
            if (saved.pullRequestId !== undefined) {
                assert.ok(Number.isSafeInteger(saved.pullRequestId) && saved.pullRequestId > 0);
                const pr = await fixture.request<{ sourceRefName: string; targetRefName: string }>('GET', `pullrequests/${saved.pullRequestId}`);
                assert.strictEqual(pr.sourceRefName, fixture.sourceRef);
                assert.strictEqual(pr.targetRefName, fixture.baseRef);
                fixture.pullRequestId = saved.pullRequestId;
            }
            await fixture.cleanup();
        }
    }

    get url(): string {
        assert.ok(this.pullRequestId);
        return `https://dev.azure.com/vinaychandra/Personal/_git/E2ETestRepo/pullrequest/${this.pullRequestId}`;
    }

    get sourceCommit(): string {
        const commit = this.refs.get(this.sourceRef);
        assert.ok(commit);
        return commit;
    }

    async request<Result>(method: string, resource = '', body?: unknown, parameters: Record<string, string> = {}): Promise<Result> {
        const token = await this.getToken();
        assert.ok(token, 'Run npm run test:live:signin before live tests.');
        const url = new URL(`${repositoryApi}${resource ? `/${resource}` : ''}`);
        url.searchParams.set('api-version', '7.1');
        for (const [name, value] of Object.entries(parameters)) { url.searchParams.set(name, value); }
        for (let attempt = 0; attempt < 3; attempt++) {
            let response: Response;
            try {
                response = await fetch(url, {
                    method,
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: body === undefined ? undefined : JSON.stringify(body),
                    redirect: 'error',
                    signal: AbortSignal.timeout(30000),
                });
            } catch (error) {
                if ((method !== 'GET' && method !== 'PATCH') || attempt === 2) { throw error; }
                await delay(250 * (attempt + 1));
                continue;
            }
            if (!response.ok) {
                throw new Error(`Azure DevOps ${method} ${url.pathname} returned HTTP ${response.status}.`);
            }
            return response.status === 204 ? undefined as Result : await response.json() as Result;
        }
        throw new Error('HTTP request did not complete.');
    }

    async create(): Promise<void> {
        const repository = await this.request<{ name: string; project: { name: string }; defaultBranch?: string }>('GET');
        assert.strictEqual(repository.name, 'E2ETestRepo');
        assert.strictEqual(repository.project.name, 'Personal');
        const { value: existingRefs } = await this.request<{ value: Ref[] }>('GET', 'refs', undefined, { filter: 'heads/' });
        let anchor = existingRefs.find(ref => ref.name === repository.defaultBranch) ?? existingRefs[0];
        if (!anchor) {
            const initial = await this.request<{ refUpdates: { name: string; newObjectId: string }[] }>('POST', 'pushes', {
                refUpdates: [{ name: 'refs/heads/main', oldObjectId: zeroId }],
                commits: [{ comment: 'Initialize E2E test repository', changes: [{
                    changeType: 'add', item: { path: '/README.md' },
                    newContent: { content: '# Extension live-test repository\n', contentType: 'rawtext' },
                }] }],
            });
            anchor = { name: 'refs/heads/main', objectId: initial.refUpdates[0].newObjectId };
        }
        await this.createRef(this.baseRef, anchor.objectId);
        await this.push(this.baseRef, [
            this.contentChange('add', this.filePath, this.content('BASE')),
            this.contentChange('add', this.deletedPath, "export const removed = 'E2E_LEFT_ANCHOR';\n"),
        ]);
        await this.createRef(this.sourceRef, this.refs.get(this.baseRef)!);
        await this.push(this.sourceRef, [this.contentChange('edit', this.filePath, this.content('E2E_ANCHOR'))]);
        const pr = await this.request<{ pullRequestId: number }>('POST', 'pullrequests', {
            sourceRefName: this.sourceRef,
            targetRefName: this.baseRef,
            title: `[E2E ${this.runId}] Iteration comment tracking`,
            description: 'Disposable extension live-test PR. Automatically abandoned after testing.',
            isDraft: true,
        });
        assert.ok(Number.isSafeInteger(pr.pullRequestId) && pr.pullRequestId > 0);
        this.pullRequestId = pr.pullRequestId;
        this.saveLedger();
        await this.waitForIteration(1);
        this.record('Created isolated branches and draft PR');
    }

    async addShiftAndDeletion(): Promise<void> {
        await this.push(this.sourceRef, [
            this.contentChange('edit', this.filePath, `export const prefixOne = 1;\nexport const prefixTwo = 2;\n${this.content('E2E_ANCHOR')}`),
            { changeType: 'delete', item: { path: this.deletedPath } },
        ]);
        await this.waitForIteration(2);
    }

    async addRename(): Promise<void> {
        await this.push(this.sourceRef, [{
            changeType: 'rename',
            sourceServerItem: this.filePath,
            item: { path: this.renamedPath },
        }]);
        await this.waitForIteration(3);
    }

    async findThread(body: string, iteration: number, baseIteration: number): Promise<RestThread> {
        const threads = await waitFor('posted comment through independent HTTP',
            () => this.request<{ value: RestThread[] }>('GET', `pullrequests/${this.pullRequestId}/threads`, undefined, {
                '$iteration': String(iteration), '$baseIteration': String(baseIteration),
            }),
            result => result.value.some(thread => thread.comments?.some(comment => comment.content === body)),
        );
        return threads.value.find(thread => thread.comments?.some(comment => comment.content === body))!;
    }

    async cleanup(): Promise<void> {
        const errors: Error[] = [];
        if (this.pullRequestId) {
            try {
                await this.request('PATCH', `pullrequests/${this.pullRequestId}`, { status: 'abandoned' });
                const pr = await this.request<{ status: string }>('GET', `pullrequests/${this.pullRequestId}`);
                assert.strictEqual(pr.status, 'abandoned');
            } catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
        }
        for (const [name, objectId] of [...this.refs].reverse()) {
            assert.ok(name.startsWith(`refs/heads/azdo-live/${this.runId}/`));
            try {
                const current = await this.request<{ value: Ref[] }>('GET', 'refs', undefined, { filter: name.replace(/^refs\//, '') });
                const existing = current.value.find(ref => ref.name === name);
                if (!existing) { this.refs.delete(name); continue; }
                assert.strictEqual(existing.objectId, objectId, `Ref ${name} changed outside the recorded run; refusing to delete it.`);
                const result = await this.request<{ value: RefResult[] }>('POST', 'refs', [{ name, oldObjectId: objectId, newObjectId: zeroId }]);
                assert.ok(result.value[0]?.success, `Cleanup of ${name}: ${result.value[0]?.updateStatus}`);
                this.refs.delete(name);
            } catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
        }
        try {
            const remaining = await this.request<{ value: Ref[] }>('GET', 'refs', undefined, { filter: `heads/azdo-live/${this.runId}/` });
            assert.strictEqual(remaining.value.length, 0, 'Run-owned branches remain after cleanup.');
        } catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
        if (!errors.length) { this.checks.push('Verified PR abandonment and branch removal through HTTP'); }
        this.saveLedger(errors.length ? 'cleanup-failed' : 'cleaned', errors.map(error => error.message));
        if (errors.length) { throw new AggregateError(errors, `Cleanup failed. Owned artifacts are recorded in ${this.ledgerPath}.`); }
    }

    record(check: string): void {
        this.checks.push(check);
        this.saveLedger();
        console.log(`[live] ${check}`);
    }

    private content(value: string): string {
        const unchanged = Array.from({ length: 12 }, (_unused, index) => `export const stable${index} = 'unchanged context ${index}';`).join('\n');
        return `export const heading = 'base';\nexport function reviewed() {\n    return '${value}';\n}\n${unchanged}\n`;
    }

    private contentChange(changeType: 'add' | 'edit', path: string, content: string): Change {
        return { changeType, item: { path }, newContent: { content, contentType: 'rawtext' } };
    }

    private async createRef(name: string, objectId: string): Promise<void> {
        assert.ok(name.startsWith(`refs/heads/azdo-live/${this.runId}/`));
        this.refs.set(name, objectId);
        this.saveLedger();
        const result = await this.request<{ value: RefResult[] }>('POST', 'refs', [{ name, oldObjectId: zeroId, newObjectId: objectId }]);
        assert.ok(result.value[0]?.success, `Creating ${name}: ${result.value[0]?.updateStatus}`);
    }

    private async push(name: string, changes: Change[]): Promise<void> {
        const oldObjectId = this.refs.get(name);
        assert.ok(oldObjectId, 'Only run-owned branches may be updated.');
        assert.ok(changes.every(change => change.item.path.startsWith(`${this.directory}/`)));
        const result = await this.request<{ refUpdates: { newObjectId: string }[] }>('POST', 'pushes', {
            refUpdates: [{ name, oldObjectId }],
            commits: [{ comment: `Live test ${this.runId}`, changes }],
        });
        assert.ok(result.refUpdates[0]?.newObjectId);
        this.refs.set(name, result.refUpdates[0].newObjectId);
        this.saveLedger();
    }

    private async waitForIteration(count: number): Promise<void> {
        await waitFor(`PR iteration ${count}`, () => this.request<{ value: GitPullRequestIteration[] }>(
            'GET', `pullrequests/${this.pullRequestId}/iterations`,
        ), result => result.value.length === count && result.value[count - 1].sourceRefCommit?.commitId === this.sourceCommit);
    }

    private saveLedger(state = 'running', errors: string[] = []): void {
        writeFileSync(this.ledgerPath, JSON.stringify({
            repository: 'vinaychandra/Personal/E2ETestRepo', runId: this.runId,
            pullRequestId: this.pullRequestId, refs: Object.fromEntries(this.refs), checks: this.checks, state, errors,
        }, null, 2));
    }
}