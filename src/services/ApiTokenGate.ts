import * as crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Opt-in bearer-token guard for the orchestrator's /api/v1/* surface.
 *
 * Default-off feature flag (Symphony pre-approved scope: "Feature
 * flags behind defaults that match current behavior"). If the env var
 * is unset, `enabled` is false and `verify()` returns true for every
 * request — the orchestrator runs exactly as it did before iter 04.
 *
 * When the env var is set, every `/api/v1/*` request must carry
 *
 *     Authorization: Bearer <KOVAEL_API_TOKEN>
 *
 * Verification hashes both the presented and expected tokens to a
 * fixed-length SHA-256 digest and compares the digests via
 * `crypto.timingSafeEqual`. Hashing first avoids the wall-clock side
 * channel a length-equality short-circuit would leak: an attacker can
 * no longer probe token length by measuring how quickly a 401 comes
 * back for guesses of different sizes. Pre-image resistance of SHA-256
 * means equal digests imply equal tokens.
 *
 * The WebSocket upgrade path is intentionally **not** gated here —
 * the WS handshake passes through a different code path and would
 * need a token-bearing query param or a custom upgrade header. Tracked
 * for a separate iteration.
 */
export class ApiTokenGate {
    public readonly enabled: boolean;
    private readonly expectedHash: Buffer | null;

    constructor(envVarName = 'KOVAEL_API_TOKEN', env: NodeJS.ProcessEnv = process.env) {
        const raw = env[envVarName];
        if (raw && raw.length > 0) {
            this.enabled = true;
            this.expectedHash = crypto.createHash('sha256').update(raw, 'utf8').digest();
        } else {
            this.enabled = false;
            this.expectedHash = null;
        }
    }

    /**
     * Returns true iff the request is allowed through. Gate-disabled →
     * always true. Gate-enabled → header is hashed and compared to the
     * stored hash in constant time, regardless of presented length.
     */
    public verify(req: IncomingMessage): boolean {
        if (!this.enabled || this.expectedHash === null) return true;

        const header = req.headers['authorization'];
        if (typeof header !== 'string') return false;

        const prefix = 'Bearer ';
        if (!header.startsWith(prefix)) return false;

        const presented = header.slice(prefix.length);
        const presentedHash = crypto.createHash('sha256').update(presented, 'utf8').digest();
        return crypto.timingSafeEqual(presentedHash, this.expectedHash);
    }

    /**
     * Write a 401 with a minimal JSON body. Avoids echoing the
     * presented header to keep stray secrets out of logs.
     */
    public respond401(res: ServerResponse, reason: 'missing' | 'invalid'): void {
        res.writeHead(401, {
            'content-type': 'application/json',
            'www-authenticate': 'Bearer realm="kovael"',
        });
        res.end(JSON.stringify({ error: 'unauthorized', reason }));
    }
}
