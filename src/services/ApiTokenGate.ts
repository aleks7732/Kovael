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
 * Verification uses `crypto.timingSafeEqual` to avoid leaking the
 * token via wall-clock side channels. Inputs are forced to equal
 * length before the compare so a wrong-length token returns 401, not
 * 500 (the underlying API throws on length mismatch).
 *
 * The WebSocket upgrade path is intentionally **not** gated here —
 * the WS handshake passes through a different code path and would
 * need a token-bearing query param or a custom upgrade header. Tracked
 * for a separate iteration.
 */
export class ApiTokenGate {
    public readonly enabled: boolean;
    private readonly expected: Buffer | null;

    constructor(envVarName = 'KOVAEL_API_TOKEN', env: NodeJS.ProcessEnv = process.env) {
        const raw = env[envVarName];
        if (raw && raw.length > 0) {
            this.enabled = true;
            this.expected = Buffer.from(raw, 'utf8');
        } else {
            this.enabled = false;
            this.expected = null;
        }
    }

    /**
     * Returns true iff the request is allowed through. Gate-disabled →
     * always true. Gate-enabled → header must match in constant time.
     */
    public verify(req: IncomingMessage): boolean {
        if (!this.enabled || this.expected === null) return true;

        const header = req.headers['authorization'];
        if (typeof header !== 'string') return false;

        const prefix = 'Bearer ';
        if (!header.startsWith(prefix)) return false;

        const presented = Buffer.from(header.slice(prefix.length), 'utf8');
        if (presented.length !== this.expected.length) return false;

        return crypto.timingSafeEqual(presented, this.expected);
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
