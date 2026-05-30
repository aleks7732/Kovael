import { EventEmitter } from 'node:events';

/**
 * Shared test double for a spawned child process — the superset of the two prior
 * per-file copies (AgentRuntimeSupervisor / AgentRuntimeRoutes tests). The extra
 * members (`killedWith`, `exit()`) are harmless for callers that don't use them.
 */
export class FakeChild extends EventEmitter {
    public pid: number;
    public killedWith: NodeJS.Signals | undefined;
    public signals: NodeJS.Signals[] = [];
    public stdout: NodeJS.ReadableStream | null = null;
    public stderr: NodeJS.ReadableStream | null = null;

    constructor(
        pid = 4242,
        private readonly exitOnKill = true,
    ) {
        super();
        this.pid = pid;
    }

    public kill(signal?: NodeJS.Signals): boolean {
        this.killedWith = signal;
        if (signal) this.signals.push(signal);
        if (this.exitOnKill) {
            this.emit('exit', 0, signal ?? null);
        }
        return true;
    }

    public exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
        this.emit('exit', code, signal);
    }
}
