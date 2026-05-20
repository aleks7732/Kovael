import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

/**
 * Chair Beacon Protocol — runtime presence tracking for live agents.
 *
 * The cockpit's static AgentCards describe *who could occupy* each chair;
 * the registry tracks *who actually has*. Any agent process — CLI, IDE,
 * sandbox, local LLM — claims a chair, emits periodic heartbeats over
 * HTTP (`POST /api/v1/chairs/heartbeat`), and releases on shutdown.
 *
 * Liveness windows (configurable via ChairRegistryConfig):
 *   - healthy:  beacon < healthyMs (default 15s) → status: 'online'
 *   - stale:    healthyMs ≤ beacon < offlineMs   → status: 'stale'
 *   - offline:  beacon ≥ offlineMs (default 30s) → status: 'offline' and evicted
 *
 * Trust posture: this service runs in-process with the orchestrator and
 * is reachable on the same HTTP port as the WS bus. The endpoints are
 * intended for localhost / private mesh use; do not expose to the public
 * internet without additional authentication.
 */

export type ChairStatus = 'online' | 'stale' | 'offline';

export interface ChairClaim {
    agentId: string;
    sessionId: string;
    provider: string;
    capabilities: string[];
    trustTier: number;
    claimedAt: number;
    lastBeaconAt: number;
    status: ChairStatus;
    host?: string;
    note?: string;
}

export interface ChairEvent {
    kind: 'claimed' | 'heartbeat' | 'released' | 'stale' | 'expired';
    agentId: string;
    sessionId: string;
    status: ChairStatus;
    timestamp: number;
    /** Snapshot of the chair *after* this event applied. Absent for `released`/`expired`. */
    chair?: ChairClaim;
    /** Why the chair entered this state (e.g. "client_release", "ttl_exceeded"). */
    reason?: string;
}

export interface ChairRegistryConfig {
    /** Beacons newer than this stay 'online'. Default 15s. */
    healthyMs: number;
    /** Beacons older than this evict the chair as 'offline'. Default 30s. */
    offlineMs: number;
    /** Sweep cadence. Default 2.5s. */
    sweepIntervalMs: number;
}

export const DEFAULT_CHAIR_REGISTRY_CONFIG: ChairRegistryConfig = {
    healthyMs: 15_000,
    offlineMs: 30_000,
    sweepIntervalMs: 2_500,
};

export class ChairRegistry extends EventEmitter {
    private cfg: ChairRegistryConfig;
    private chairs: Map<string, ChairClaim> = new Map();
    private sweeper: NodeJS.Timeout | null = null;

    constructor(config: Partial<ChairRegistryConfig> = {}) {
        super();
        this.cfg = { ...DEFAULT_CHAIR_REGISTRY_CONFIG, ...config };
    }

    public start(): void {
        if (this.sweeper) return;
        this.sweeper = setInterval(() => this.sweep(), this.cfg.sweepIntervalMs);
        // Don't keep the process alive on this timer alone.
        if (typeof this.sweeper.unref === 'function') this.sweeper.unref();
    }

    public stop(): void {
        if (this.sweeper) {
            clearInterval(this.sweeper);
            this.sweeper = null;
        }
    }

    /**
     * Claim a chair. If the agentId is already occupied by a different session,
     * the old session is evicted (last-writer-wins). Returns the active claim.
     */
    public claim(input: {
        agentId: string;
        provider: string;
        capabilities?: string[];
        trustTier?: number;
        host?: string;
        note?: string;
    }): ChairClaim {
        const now = Date.now();
        const existing = this.chairs.get(input.agentId);
        if (existing) {
            this.emit('chair_event', {
                kind: 'released',
                agentId: existing.agentId,
                sessionId: existing.sessionId,
                status: 'offline',
                timestamp: now,
                reason: 'superseded_by_new_claim',
            } satisfies ChairEvent);
        }

        const claim: ChairClaim = {
            agentId: input.agentId,
            sessionId: crypto.randomUUID(),
            provider: input.provider,
            capabilities: input.capabilities ?? [],
            trustTier: input.trustTier ?? 3,
            claimedAt: now,
            lastBeaconAt: now,
            status: 'online',
            host: input.host,
            note: input.note,
        };
        this.chairs.set(claim.agentId, claim);
        this.emit('chair_event', {
            kind: 'claimed',
            agentId: claim.agentId,
            sessionId: claim.sessionId,
            status: claim.status,
            timestamp: now,
            chair: { ...claim },
        } satisfies ChairEvent);
        return claim;
    }

    /**
     * Refresh the heartbeat timestamp. The sessionId must match the active
     * claim — heartbeats from stale sessions are rejected so a crashed agent
     * cannot resurrect itself after a new claim has taken its chair.
     */
    public heartbeat(agentId: string, sessionId: string, note?: string): ChairClaim | null {
        const chair = this.chairs.get(agentId);
        if (!chair) return null;
        if (chair.sessionId !== sessionId) return null;

        const now = Date.now();
        chair.lastBeaconAt = now;
        if (note !== undefined) chair.note = note;
        const previousStatus = chair.status;
        chair.status = 'online';

        this.emit('chair_event', {
            kind: previousStatus === 'online' ? 'heartbeat' : 'claimed',
            agentId: chair.agentId,
            sessionId: chair.sessionId,
            status: chair.status,
            timestamp: now,
            chair: { ...chair },
            reason: previousStatus !== 'online' ? `revived_from_${previousStatus}` : undefined,
        } satisfies ChairEvent);
        return chair;
    }

    /**
     * Graceful release. Returns true if the chair was held by this session.
     */
    public release(agentId: string, sessionId: string, reason = 'client_release'): boolean {
        const chair = this.chairs.get(agentId);
        if (!chair) return false;
        if (chair.sessionId !== sessionId) return false;
        this.chairs.delete(agentId);
        this.emit('chair_event', {
            kind: 'released',
            agentId,
            sessionId,
            status: 'offline',
            timestamp: Date.now(),
            reason,
        } satisfies ChairEvent);
        return true;
    }

    public snapshot(): ChairClaim[] {
        return Array.from(this.chairs.values()).map((c) => ({ ...c }));
    }

    public get(agentId: string): ChairClaim | undefined {
        const c = this.chairs.get(agentId);
        return c ? { ...c } : undefined;
    }

    private sweep(): void {
        const now = Date.now();
        for (const chair of Array.from(this.chairs.values())) {
            const age = now - chair.lastBeaconAt;
            if (age >= this.cfg.offlineMs) {
                this.chairs.delete(chair.agentId);
                this.emit('chair_event', {
                    kind: 'expired',
                    agentId: chair.agentId,
                    sessionId: chair.sessionId,
                    status: 'offline',
                    timestamp: now,
                    reason: `ttl_exceeded:age_ms=${age}`,
                } satisfies ChairEvent);
                continue;
            }
            if (age >= this.cfg.healthyMs && chair.status !== 'stale') {
                chair.status = 'stale';
                this.emit('chair_event', {
                    kind: 'stale',
                    agentId: chair.agentId,
                    sessionId: chair.sessionId,
                    status: chair.status,
                    timestamp: now,
                    chair: { ...chair },
                    reason: `beacon_age_ms=${age}`,
                } satisfies ChairEvent);
            }
        }
    }

    public stats(): { total: number; online: number; stale: number } {
        let online = 0;
        let stale = 0;
        for (const c of this.chairs.values()) {
            if (c.status === 'online') online += 1;
            else if (c.status === 'stale') stale += 1;
        }
        return { total: this.chairs.size, online, stale };
    }

    public config(): Readonly<ChairRegistryConfig> {
        return { ...this.cfg };
    }
}
