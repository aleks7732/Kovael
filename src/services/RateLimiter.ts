import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

// Strip the IPv4-mapped IPv6 prefix so 1.2.3.4 and ::ffff:1.2.3.4 share a
// single bucket — otherwise a dual-stack client gets two full quotas.
function normalizeIp(addr: string): string {
    if (addr.startsWith('::ffff:')) {
        const v4 = addr.slice('::ffff:'.length);
        if (isIP(v4) === 4) return v4;
    }
    return addr;
}

export interface RateLimiterConfig {
    /** Maximum tokens a bucket can hold (burst capacity). Default 60. */
    capacity: number;
    /** Tokens added per second (steady-state allowance). Default 1. */
    refillPerSec: number;
    /** Hard cap on tracked IP buckets before LRU eviction. Default 10_000. */
    maxEntries: number;
}

export const DEFAULT_RATE_LIMITER_CONFIG: RateLimiterConfig = {
    capacity: 60,
    refillPerSec: 1,
    maxEntries: 10_000,
};

export interface RateLimitDecision {
    /** True iff the request consumed a token. */
    allowed: boolean;
    /** Tokens remaining in the bucket after this decision. */
    remaining: number;
    /** Seconds (>=1, integer-ceil) until at least one token becomes available. 0 when allowed. */
    retryAfterS: number;
}

interface Bucket {
    tokens: number;
    lastRefillMs: number;
}

/**
 * Per-IP token-bucket rate limiter for the `/api/v1/*` surface.
 *
 * Scope (Symphony "secure-by-default" pre-approved):
 *   - One bucket per remote IP, shared across all routes (no per-route quotas).
 *   - 60 tokens default capacity, refills at 1 token/sec (60/min steady state).
 *   - Sits in front of `ApiTokenGate.verify()` so a flood of unauthenticated
 *     requests cannot burn auth CPU.
 *   - Probes (`/livez`, `/readyz`, `/metrics`) and the WS upgrade path are
 *     exempt — they are not gated by this limiter.
 *
 * `X-Forwarded-For` is honored ONLY when `KOVAEL_TRUST_PROXY=true`. Otherwise
 * the limiter uses `req.socket.remoteAddress`, which is the only value that
 * cannot be spoofed by a direct client. Trusting the header without an
 * upstream proxy enforcing it would let any client choose its own bucket and
 * trivially defeat the limit.
 *
 * Eviction: the bucket map is bounded at `maxEntries` (default 10k). Once
 * exceeded, the least-recently-touched bucket is evicted. This stops port
 * scanners and the public IPv4 address space at large from growing the map
 * without bound; the cost of eviction is that an evicted IP rejoins with a
 * full bucket, which is fine — they were idle long enough to fall out.
 *
 * Distributed coordination is out of scope: this is a single-orchestrator
 * limiter. If you front Kovael with multiple orchestrators behind a balancer,
 * each will keep its own buckets and the effective limit is `N × capacity`.
 */
export class RateLimiter {
    public readonly cfg: RateLimiterConfig;
    private readonly trustProxy: boolean;
    // Map iteration order is insertion order; re-inserting on touch turns it
    // into a cheap LRU without an extra linked list.
    private readonly buckets: Map<string, Bucket> = new Map();

    constructor(
        cfg: Partial<RateLimiterConfig> = {},
        env: NodeJS.ProcessEnv = process.env,
    ) {
        this.cfg = { ...DEFAULT_RATE_LIMITER_CONFIG, ...cfg };
        if (this.cfg.capacity <= 0) {
            throw new Error(`RateLimiter: capacity must be > 0 (got ${this.cfg.capacity})`);
        }
        if (this.cfg.refillPerSec <= 0) {
            throw new Error(`RateLimiter: refillPerSec must be > 0 (got ${this.cfg.refillPerSec})`);
        }
        if (this.cfg.maxEntries <= 0) {
            throw new Error(`RateLimiter: maxEntries must be > 0 (got ${this.cfg.maxEntries})`);
        }
        this.trustProxy = env.KOVAEL_TRUST_PROXY === 'true';
    }

    /**
     * Resolve the bucket key for a request. Falls back to `'unknown'` when no
     * remote address is available (e.g. unix-socket transports), which collapses
     * those callers into a single bucket rather than crashing.
     */
    public clientKey(req: IncomingMessage): string {
        if (this.trustProxy) {
            const xff = req.headers['x-forwarded-for'];
            const raw = Array.isArray(xff) ? xff[0] : xff;
            if (typeof raw === 'string' && raw.length > 0) {
                const first = raw.split(',')[0]?.trim();
                // RFC 7239 allows obfuscated identifiers (`unknown`, `_anon`)
                // that aren't IPs. Honoring those would collapse every such
                // client into one shared bucket — trivial limit bypass.
                if (first && isIP(first) !== 0) return normalizeIp(first);
            }
        }
        const remote = req.socket?.remoteAddress;
        if (remote && isIP(remote) !== 0) return normalizeIp(remote);
        return remote ?? 'unknown';
    }

    /**
     * Atomically check-and-consume one token for `key`. Refills the bucket
     * based on elapsed wall-clock time since the last touch. When the bucket
     * is empty, returns `allowed: false` with `retryAfterS` rounded UP to the
     * next whole second (clients should never poll faster than the refill).
     */
    public consume(key: string, nowMs: number = Date.now()): RateLimitDecision {
        const bucket = this.touch(key, nowMs);
        this.refill(bucket, nowMs);

        if (bucket.tokens >= 1) {
            bucket.tokens -= 1;
            return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterS: 0 };
        }

        const deficit = 1 - bucket.tokens;
        const retryAfterS = Math.max(1, Math.ceil(deficit / this.cfg.refillPerSec));
        return { allowed: false, remaining: 0, retryAfterS };
    }

    /** Number of distinct IP buckets currently tracked. */
    public size(): number {
        return this.buckets.size;
    }

    /** Reset all buckets (test hook — not used in production code paths). */
    public reset(): void {
        this.buckets.clear();
    }

    private touch(key: string, nowMs: number): Bucket {
        const existing = this.buckets.get(key);
        if (existing) {
            // Re-insert so this key becomes the most-recently-used.
            this.buckets.delete(key);
            this.buckets.set(key, existing);
            return existing;
        }
        if (this.buckets.size >= this.cfg.maxEntries) {
            const oldest = this.buckets.keys().next().value;
            if (oldest !== undefined) this.buckets.delete(oldest);
        }
        const fresh: Bucket = { tokens: this.cfg.capacity, lastRefillMs: nowMs };
        this.buckets.set(key, fresh);
        return fresh;
    }

    private refill(bucket: Bucket, nowMs: number): void {
        const elapsedMs = nowMs - bucket.lastRefillMs;
        if (elapsedMs <= 0) return;
        const added = (elapsedMs / 1000) * this.cfg.refillPerSec;
        bucket.tokens = Math.min(this.cfg.capacity, bucket.tokens + added);
        bucket.lastRefillMs = nowMs;
    }
}
