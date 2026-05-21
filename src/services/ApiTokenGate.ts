import * as crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type WebSocketAuthSource = 'header' | 'query' | 'subprotocol';

export interface WebSocketAuthOutcome {
    allowed: boolean;
    source: WebSocketAuthSource | null;
    // The exact subprotocol string the client offered (e.g. `bearer.abc123`).
    // Must be echoed back in `Sec-WebSocket-Protocol` on accept, otherwise
    // browsers reject the connection with a protocol-mismatch error.
    selectedSubprotocol: string | null;
}

/**
 * Opt-in bearer-token guard for the orchestrator's /api/v1/*, /metrics,
 * and WebSocket upgrade surfaces.
 *
 * Default-off feature flag (Symphony pre-approved scope: "Feature
 * flags behind defaults that match current behavior"). If the env var
 * is unset, `enabled` is false and `verify()` / `verifyWebSocketUpgrade()`
 * always return success — the orchestrator runs exactly as it did before
 * iter 04.
 *
 * When the env var is set, every gated request must present
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
 * The WebSocket upgrade path accepts the token via three transports
 * (any one suffices — clients only need one):
 *
 *   1. `Authorization: Bearer <token>` header — for non-browser clients.
 *      Browsers cannot set arbitrary headers on `new WebSocket(...)`.
 *   2. `?token=<token>` query parameter on the WS URL — universal but
 *      exposes the secret in server access logs.
 *   3. `Sec-WebSocket-Protocol: bearer.<token>` subprotocol — the
 *      canonical browser-friendly path. The selected subprotocol is
 *      echoed back so the handshake completes cleanly.
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

    public verify(req: IncomingMessage): boolean {
        if (!this.enabled || this.expectedHash === null) return true;

        const header = req.headers['authorization'];
        if (typeof header !== 'string') return false;

        const prefix = 'Bearer ';
        if (!header.startsWith(prefix)) return false;

        return this.matches(header.slice(prefix.length));
    }

    /**
     * Returns whether the WS upgrade is authorized and, if a subprotocol
     * carried the token, the exact protocol string to echo back so the
     * handshake completes.
     */
    public verifyWebSocketUpgrade(req: IncomingMessage): WebSocketAuthOutcome {
        if (!this.enabled || this.expectedHash === null) {
            return { allowed: true, source: null, selectedSubprotocol: null };
        }

        const header = req.headers['authorization'];
        if (typeof header === 'string' && header.startsWith('Bearer ')) {
            if (this.matches(header.slice('Bearer '.length))) {
                return { allowed: true, source: 'header', selectedSubprotocol: null };
            }
        }

        const subprotocols = parseSubprotocols(req.headers['sec-websocket-protocol']);
        for (const proto of subprotocols) {
            if (proto.startsWith('bearer.')) {
                if (this.matches(proto.slice('bearer.'.length))) {
                    return { allowed: true, source: 'subprotocol', selectedSubprotocol: proto };
                }
            }
        }

        const queryToken = extractQueryToken(req.url);
        if (queryToken !== null && this.matches(queryToken)) {
            return { allowed: true, source: 'query', selectedSubprotocol: null };
        }

        return { allowed: false, source: null, selectedSubprotocol: null };
    }

    public respond401(res: ServerResponse, reason: 'missing' | 'invalid'): void {
        res.writeHead(401, {
            'content-type': 'application/json',
            'www-authenticate': 'Bearer realm="kovael"',
        });
        res.end(JSON.stringify({ error: 'unauthorized', reason }));
    }

    private matches(presented: string): boolean {
        if (this.expectedHash === null) return false;
        const presentedHash = crypto.createHash('sha256').update(presented, 'utf8').digest();
        return crypto.timingSafeEqual(presentedHash, this.expectedHash);
    }
}

function parseSubprotocols(header: string | string[] | undefined): string[] {
    if (header === undefined) return [];
    const raw = Array.isArray(header) ? header.join(',') : header;
    return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function extractQueryToken(rawUrl: string | undefined): string | null {
    if (!rawUrl) return null;
    // Base URL is irrelevant — we only read the query string.
    const url = new URL(rawUrl, 'http://localhost');
    return url.searchParams.get('token');
}
