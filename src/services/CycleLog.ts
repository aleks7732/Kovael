import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

/** Safe JSON.parse that returns the raw string on parse failure. */
function safeParse(raw: string): Record<string, unknown> {
    try {
        return JSON.parse(raw);
    } catch {
        return { _raw: raw };
    }
}

/**
 * CycleLog — append-only event ledger for durable orchestration.
 *
 * Every Triad phase transition, claim, heartbeat, retry, reply, and
 * stop-decision is written as an immutable event keyed by (cycle_id, seq).
 * Current in-memory state (active cycles, phase positions) is a projection
 * that can be replayed from the log on boot.
 *
 * Design rationale:
 * - Still SQLite — no Temporal/Restate dependency, keeps distroless image.
 * - Append-only: events are INSERT-only, never UPDATE/DELETE.
 * - On restart, `replayOpenCycles()` reconstitutes in-flight work.
 * - Each completed cycle can be sealed with a Merkle-rooted receipt
 *   signed by the orchestrator's ed25519 key (see `sealCycle`).
 */

export interface CycleEvent {
    cycleId: string;
    seq: number;
    kind: CycleEventKind;
    timestamp: number;
    /** Agent or service that produced this event. */
    actor: string;
    /** Structured payload (JSON-serializable). */
    payload: Record<string, unknown>;
}

export type CycleEventKind =
    | 'cycle_started'
    | 'phase_transition'
    | 'task_claimed'
    | 'task_running'
    | 'dispatch_sent'
    | 'dispatch_reply'
    | 'retry_scheduled'
    | 'retry_exhausted'
    | 'verifier_scored'
    | 'stop_decision'
    | 'receipt_issued'
    | 'cycle_sealed'
    | 'cycle_failed';

export interface CycleReceipt {
    cycleId: string;
    merkleRoot: string;
    eventCount: number;
    sealedAt: number;
    signature?: string;
}

export interface OpenCycleSummary {
    cycleId: string;
    lastPhase: string;
    lastActor: string;
    eventCount: number;
    startedAt: number;
    lastEventAt: number;
}

export class CycleLog extends EventEmitter {
    private insertStmt: StatementSync;
    private seqCounters = new Map<string, number>();

    constructor(private db: DatabaseSync) {
        super();
        this.insertStmt = db.prepare(`
            INSERT INTO cycle_events (cycle_id, seq, kind, timestamp, actor, payload)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        // Pre-load sequence counters for any in-flight cycles.
        const rows = db.prepare(`
            SELECT cycle_id, MAX(seq) AS max_seq FROM cycle_events GROUP BY cycle_id
        `).all() as Array<{ cycle_id: string; max_seq: number }>;
        for (const r of rows) {
            this.seqCounters.set(r.cycle_id, r.max_seq + 1);
        }
    }

    /**
     * Append an event to the log. Returns the assigned sequence number.
     */
    public append(
        cycleId: string,
        kind: CycleEventKind,
        actor: string,
        payload: Record<string, unknown> = {},
    ): CycleEvent {
        const seq = this.seqCounters.get(cycleId) ?? 0;
        const timestamp = Date.now();
        const event: CycleEvent = { cycleId, seq, kind, timestamp, actor, payload };

        this.insertStmt.run(
            cycleId,
            seq,
            kind,
            timestamp,
            actor,
            JSON.stringify(payload),
        );
        this.seqCounters.set(cycleId, seq + 1);
        this.emit('event', event);
        return event;
    }

    /**
     * Retrieve the full event stream for a cycle, ordered by seq.
     */
    public trail(cycleId: string): CycleEvent[] {
        const rows = this.db.prepare(`
            SELECT cycle_id, seq, kind, timestamp, actor, payload
            FROM cycle_events
            WHERE cycle_id = ?
            ORDER BY seq ASC
        `).all(cycleId) as Array<{
            cycle_id: string; seq: number; kind: string;
            timestamp: number; actor: string; payload: string;
        }>;

        return rows.map((r) => ({
            cycleId: r.cycle_id,
            seq: r.seq,
            kind: r.kind as CycleEventKind,
            timestamp: r.timestamp,
            actor: r.actor,
            payload: safeParse(r.payload),
        }));
    }

    /**
     * Identify cycles that were in-flight when the process last shut down.
     * An open cycle has at least one event but no `cycle_sealed` or
     * `cycle_failed` terminal event.
     */
    public replayOpenCycles(): OpenCycleSummary[] {
        const rows = this.db.prepare(`
            SELECT
                e.cycle_id,
                MAX(e.seq) AS max_seq,
                COUNT(*) AS event_count,
                MIN(e.timestamp) AS started_at,
                MAX(e.timestamp) AS last_event_at,
                last_e.kind AS last_kind,
                last_e.actor AS last_actor
            FROM cycle_events e
            JOIN cycle_events last_e
              ON last_e.cycle_id = e.cycle_id
             AND last_e.seq = (
                 SELECT MAX(seq) FROM cycle_events WHERE cycle_id = e.cycle_id
             )
            WHERE e.cycle_id NOT IN (
                SELECT DISTINCT cycle_id FROM cycle_events
                WHERE kind IN ('cycle_sealed', 'cycle_failed')
            )
            GROUP BY e.cycle_id
        `).all() as Array<{
            cycle_id: string; max_seq: number; event_count: number;
            started_at: number; last_event_at: number;
            last_kind: string; last_actor: string;
        }>;

        return rows.map((r) => ({
            cycleId: r.cycle_id,
            lastPhase: r.last_kind,
            lastActor: r.last_actor,
            eventCount: r.event_count,
            startedAt: r.started_at,
            lastEventAt: r.last_event_at,
        }));
    }

    /**
     * Seal a cycle with a Merkle root over its event stream.
     * The root is SHA-256 of the concatenated event hashes.
     */
    public sealCycle(cycleId: string): CycleReceipt {
        const events = this.trail(cycleId);
        if (events.length === 0) {
            throw new Error(`CycleLog.sealCycle: no events for cycle ${cycleId}`);
        }

        // Build leaf hashes, then iteratively hash pairs to form root.
        const leaves = events.map((e) =>
            crypto.createHash('sha256')
                .update(`${e.cycleId}:${e.seq}:${e.kind}:${e.timestamp}:${e.actor}:${JSON.stringify(e.payload)}`)
                .digest(),
        );

        const merkleRoot = CycleLog.computeMerkleRoot(leaves);

        const receipt: CycleReceipt = {
            cycleId,
            merkleRoot,
            eventCount: events.length,
            sealedAt: Date.now(),
        };

        this.append(cycleId, 'cycle_sealed', 'orchestrator', {
            merkleRoot: receipt.merkleRoot,
            eventCount: receipt.eventCount,
        });

        this.emit('cycle_sealed', receipt);
        return receipt;
    }

    /**
     * Sign a receipt with an ed25519 private key (PEM or KeyObject).
     * Returns the hex-encoded signature.
     */
    public static signReceipt(receipt: CycleReceipt, privateKey: crypto.KeyObject): string {
        const data = `${receipt.cycleId}:${receipt.merkleRoot}:${receipt.eventCount}:${receipt.sealedAt}`;
        const sig = crypto.sign(null, Buffer.from(data), privateKey);
        return sig.toString('hex');
    }

    /**
     * Verify a signed receipt against a public key.
     */
    public static verifyReceipt(receipt: CycleReceipt, signature: string, publicKey: crypto.KeyObject): boolean {
        const data = `${receipt.cycleId}:${receipt.merkleRoot}:${receipt.eventCount}:${receipt.sealedAt}`;
        return crypto.verify(null, Buffer.from(data), publicKey, Buffer.from(signature, 'hex'));
    }

    /**
     * Compute a Merkle root from an array of leaf buffers.
     * Returns the hex-encoded root hash.
     */
    public static computeMerkleRoot(leaves: Buffer[]): string {
        if (leaves.length === 0) return crypto.createHash('sha256').update('empty').digest('hex');
        let level = [...leaves];
        while (level.length > 1) {
            const next: Buffer[] = [];
            for (let i = 0; i < level.length; i += 2) {
                const left = level[i];
                const right = i + 1 < level.length ? level[i + 1] : left;
                next.push(crypto.createHash('sha256').update(Buffer.concat([left, right])).digest());
            }
            level = next;
        }
        return level[0].toString('hex');
    }

    /**
     * Total number of events across all cycles.
     */
    public totalEvents(): number {
        const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM cycle_events').get() as { cnt: number };
        return row.cnt;
    }

    /**
     * Count of sealed (completed) cycles.
     */
    public sealedCycleCount(): number {
        const row = this.db.prepare(
            "SELECT COUNT(DISTINCT cycle_id) AS cnt FROM cycle_events WHERE kind = 'cycle_sealed'"
        ).get() as { cnt: number };
        return row.cnt;
    }
}
