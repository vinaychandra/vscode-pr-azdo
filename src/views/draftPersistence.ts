import * as vscode from 'vscode';
import type { PersistedDrafts } from './prCommentController';

export class DraftPersistenceManager implements vscode.Disposable {
    private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
    private readonly inFlight = new Set<Promise<void>>();
    private disposed = false;

    constructor(
        private readonly workspaceState: vscode.Memento,
        private readonly stateKey: string,
        private readonly getDrafts: (prId: number) => PersistedDrafts,
        private readonly log: vscode.OutputChannel,
        private readonly delayMs = 500,
    ) { }

    schedule(prId: number): void {
        if (this.disposed) { return; }
        const existing = this.timers.get(prId);
        if (existing) { clearTimeout(existing); }
        this.timers.set(prId, setTimeout(() => {
            this.timers.delete(prId);
            void this.persistTracked(prId).catch(err => this.logFailure(prId, err));
        }, this.delayMs));
    }

    async flush(): Promise<void> {
        const pendingPrIds = [...this.timers.keys()];
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        const writes: { prId?: number; operation: Promise<void> }[] = [
            ...[...this.inFlight].map(operation => ({ operation })),
            ...pendingPrIds.map(prId => ({ prId, operation: this.persistTracked(prId) })),
        ];
        const results = await Promise.allSettled(writes.map(write => write.operation));
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                const prId = writes[index].prId;
                if (prId !== undefined) { this.logFailure(prId, result.reason); }
            }
        });
    }

    dispose(): void {
        this.disposed = true;
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
    }

    private async persist(prId: number): Promise<void> {
        await this.workspaceState.update(`${this.stateKey}-${prId}`, this.getDrafts(prId));
        this.log.appendLine(`[comments] Persisted drafts for PR ${prId}`);
    }

    private persistTracked(prId: number): Promise<void> {
        const operation = this.persist(prId);
        this.inFlight.add(operation);
        void operation.then(
            () => this.inFlight.delete(operation),
            () => this.inFlight.delete(operation),
        );
        return operation;
    }

    private logFailure(prId: number, err: unknown): void {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.appendLine(`[comments] Failed to persist drafts for PR ${prId}: ${msg}`);
    }
}