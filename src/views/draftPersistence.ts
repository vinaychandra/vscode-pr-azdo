import * as vscode from 'vscode';
import type { PersistedDrafts } from './prCommentController';

export class DraftPersistenceManager implements vscode.Disposable {
    private readonly timers = new Map<number | string, ReturnType<typeof setTimeout>>();
    private readonly inFlight = new Set<Promise<void>>();
    private disposed = false;

    constructor(
        private readonly workspaceState: vscode.Memento,
        private readonly stateKey: string,
        private readonly getDrafts: (reviewScope: number | string) => PersistedDrafts,
        private readonly log: vscode.OutputChannel,
        private readonly delayMs = 500,
    ) { }

    schedule(reviewScope: number | string): void {
        if (this.disposed) { return; }
        const existing = this.timers.get(reviewScope);
        if (existing) { clearTimeout(existing); }
        this.timers.set(reviewScope, setTimeout(() => {
            this.timers.delete(reviewScope);
            void this.persistTracked(reviewScope).catch(err => this.logFailure(reviewScope, err));
        }, this.delayMs));
    }

    async flush(): Promise<void> {
        const pendingReviewScopes = [...this.timers.keys()];
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        const writes: { reviewScope?: number | string; operation: Promise<void> }[] = [
            ...[...this.inFlight].map(operation => ({ operation })),
            ...pendingReviewScopes.map(reviewScope => ({ reviewScope, operation: this.persistTracked(reviewScope) })),
        ];
        const results = await Promise.allSettled(writes.map(write => write.operation));
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                const reviewScope = writes[index].reviewScope;
                if (reviewScope !== undefined) { this.logFailure(reviewScope, result.reason); }
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

    private async persist(reviewScope: number | string): Promise<void> {
        await this.workspaceState.update(`${this.stateKey}-${reviewScope}`, this.getDrafts(reviewScope));
        this.log.appendLine(`[comments] Persisted drafts for review ${reviewScope}`);
    }

    private persistTracked(reviewScope: number | string): Promise<void> {
        const operation = this.persist(reviewScope);
        this.inFlight.add(operation);
        void operation.then(
            () => this.inFlight.delete(operation),
            () => this.inFlight.delete(operation),
        );
        return operation;
    }

    private logFailure(reviewScope: number | string, err: unknown): void {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.appendLine(`[comments] Failed to persist drafts for review ${reviewScope}: ${msg}`);
    }
}