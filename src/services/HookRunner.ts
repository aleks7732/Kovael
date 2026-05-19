import { EventEmitter } from 'node:events';

export type HookEvent = 'after_create' | 'before_run' | 'after_run' | 'before_remove';

export interface HookContext {
    cycleId: string;
    taskHash?: string;
    workspacePath?: string;
    [key: string]: unknown;
}

export interface HookHandler {
    name: string;
    event: HookEvent;
    fn: (ctx: HookContext) => void | Promise<void>;
    timeoutMs: number;
}

export interface HookResult {
    name: string;
    event: HookEvent;
    success: boolean;
    durationMs: number;
    timedOut: boolean;
    error?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

// Symphony §10.1 — these two hook events ABORT the cycle on failure.
// The other two are advisory: failures are logged but the cycle proceeds.
const ABORT_ON_FAILURE: ReadonlySet<HookEvent> = new Set(['after_create', 'before_run']);

/**
 * HookRunner — Symphony SPEC §10.1 lifecycle hooks (Apache-2.0,
 * github.com/openai/symphony).
 *
 *   after_create   — workspace ready; failure ABORTS the cycle attempt.
 *   before_run     — about to dispatch Triad; failure ABORTS the attempt.
 *   after_run      — Triad complete; failure logged, cycle proceeds.
 *   before_remove  — workspace cleanup; failure logged, cleanup proceeds.
 *
 * Every hook runs under a per-handler timeout (default 60s, per WORKFLOW.md
 * hooks.timeout_ms). Hooks register at boot or at runtime; WorkflowLoader
 * (next tick) will also pull shell-command hooks from WORKFLOW.md front
 * matter and register them here.
 */
export class HookRunner extends EventEmitter {
    private readonly handlers: Map<HookEvent, HookHandler[]> = new Map();

    public register(handler: Omit<HookHandler, 'timeoutMs'> & { timeoutMs?: number }): void {
        const full: HookHandler = {
            ...handler,
            timeoutMs: handler.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        };
        const list = this.handlers.get(handler.event) ?? [];
        list.push(full);
        this.handlers.set(handler.event, list);
    }

    public unregister(event: HookEvent, name: string): boolean {
        const list = this.handlers.get(event);
        if (!list) return false;
        const idx = list.findIndex(h => h.name === name);
        if (idx === -1) return false;
        list.splice(idx, 1);
        return true;
    }

    /**
     * Run every handler registered for `event` in registration order.
     * Returns the full result list — caller inspects `shouldAbort` to
     * decide whether to proceed.
     */
    public async run(event: HookEvent, ctx: HookContext): Promise<HookResult[]> {
        const list = this.handlers.get(event) ?? [];
        const results: HookResult[] = [];
        for (const handler of list) {
            const r = await this.runOne(handler, ctx);
            results.push(r);
            this.emit('hook_event', r);
            // Short-circuit on first failure for ABORTING events so we don't
            // do extra work after the cycle is already doomed.
            if (!r.success && ABORT_ON_FAILURE.has(event)) break;
        }
        return results;
    }

    public shouldAbort(event: HookEvent, results: HookResult[]): boolean {
        if (!ABORT_ON_FAILURE.has(event)) return false;
        return results.some(r => !r.success);
    }

    public stats(): Record<HookEvent, number> {
        return {
            after_create:  this.handlers.get('after_create')?.length  ?? 0,
            before_run:    this.handlers.get('before_run')?.length    ?? 0,
            after_run:     this.handlers.get('after_run')?.length     ?? 0,
            before_remove: this.handlers.get('before_remove')?.length ?? 0,
        };
    }

    private async runOne(handler: HookHandler, ctx: HookContext): Promise<HookResult> {
        const start = Date.now();
        let timer: NodeJS.Timeout | null = null;
        let timedOut = false;

        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                timedOut = true;
                reject(new Error(`hook_timeout_${handler.timeoutMs}ms`));
            }, handler.timeoutMs);
        });

        try {
            await Promise.race([Promise.resolve(handler.fn(ctx)), timeout]);
            return {
                name: handler.name,
                event: handler.event,
                success: true,
                durationMs: Date.now() - start,
                timedOut: false,
            };
        } catch (err) {
            return {
                name: handler.name,
                event: handler.event,
                success: false,
                durationMs: Date.now() - start,
                timedOut,
                error: (err as Error).message,
            };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}
