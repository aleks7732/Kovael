import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WorkspaceConfig {
    /** Absolute path to the root that holds per-cycle directories. */
    root: string;
    /** When true, the per-cycle dir is removed on release. */
    cleanupOnRelease: boolean;
}

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
    root: path.resolve(process.cwd(), '.kovael/workspaces'),
    cleanupOnRelease: false,
};

export class WorkspaceError extends Error {
    constructor(message: string, public readonly code: string) {
        super(message);
        this.name = 'WorkspaceError';
    }
}

const SAFE_ID = /^[a-zA-Z0-9._-]+$/;

/**
 * WorkspaceManager — Symphony SPEC §9 isolation primitive.
 * (Apache-2.0, github.com/openai/symphony)
 *
 * Per Symphony §9.0:
 *   - "Workspace path MUST stay inside workspace root"
 *   - "Sanitize identifiers to alphanumeric/dot/dash/underscore only"
 *   - "Before launching the coding-agent subprocess, validate cwd == workspace_path"
 *
 * Kovael's Triad runs in-process today (the Architect/Operator/Verifier are
 * TypeScript functions, not subprocesses), so the cwd validation is dormant
 * but the structure is in place for future subprocess agents. Every cycle
 * still gets its own directory so retried cycles can preserve incremental
 * state across attempts.
 */
export class WorkspaceManager {
    private readonly cfg: WorkspaceConfig;
    private readonly active: Map<string, string> = new Map(); // cycleId → absolutePath

    constructor(cfg: Partial<WorkspaceConfig> = {}) {
        this.cfg = { ...DEFAULT_WORKSPACE_CONFIG, ...cfg };
        fs.mkdirSync(this.cfg.root, { recursive: true });
    }

    public root(): string {
        return this.cfg.root;
    }

    /** Acquire a workspace for the given cycle id. Returns the absolute path. */
    public acquire(cycleId: string): string {
        if (!SAFE_ID.test(cycleId)) {
            throw new WorkspaceError(
                `Unsafe cycle id: ${JSON.stringify(cycleId)} — must match ${SAFE_ID}`,
                'unsafe_id',
            );
        }
        const wsPath = path.join(this.cfg.root, cycleId);
        this.assertInsideRoot(wsPath);
        fs.mkdirSync(wsPath, { recursive: true });
        this.active.set(cycleId, wsPath);
        return wsPath;
    }

    /**
     * Validate that a candidate filesystem path belongs to the supplied
     * cycle's workspace. Symphony §9 invariant: workspaces don't leak.
     */
    public validateCwd(cycleId: string, candidate: string): void {
        const ws = this.active.get(cycleId);
        if (!ws) {
            throw new WorkspaceError(`No active workspace for cycle ${cycleId}`, 'no_workspace');
        }
        const resolved = path.resolve(candidate);
        const rel = path.relative(ws, resolved);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new WorkspaceError(
                `cwd ${candidate} is outside workspace ${ws}`,
                'cwd_escape',
            );
        }
    }

    /**
     * Release the workspace. Symphony §9 lifecycle: per-issue dir is reused
     * across runs by default; opt-in cleanup deletes the dir on release.
     */
    public release(cycleId: string): void {
        const wsPath = this.active.get(cycleId);
        if (!wsPath) return;
        this.active.delete(cycleId);
        if (this.cfg.cleanupOnRelease) {
            try {
                fs.rmSync(wsPath, { recursive: true, force: true });
            } catch (err) {
                console.warn(`[WorkspaceManager] cleanup failed for ${cycleId}: ${(err as Error).message}`);
            }
        }
    }

    public activeCount(): number {
        return this.active.size;
    }

    private assertInsideRoot(candidate: string): void {
        const resolved = path.resolve(candidate);
        const rel = path.relative(this.cfg.root, resolved);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new WorkspaceError(
                `Resolved path ${candidate} escapes workspace root ${this.cfg.root}`,
                'root_escape',
            );
        }
    }
}
