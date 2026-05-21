import * as crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Bearer-token guard for the orchestrator's protected control surfaces.
 *
 * Secure-by-default: protected surfaces require `KOVAEL_API_TOKEN`.
 * Local development can explicitly opt out with
 * `KOVAEL_ALLOW_UNAUTHENTICATED=true`.
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
 * HTTP APIs use the `Authorization` header only. Browser WebSocket and
 * EventSource clients cannot set custom headers, so those upgrade/stream
 * paths may opt in to accepting a `token` query parameter.
 */
export class ApiTokenGate {
    public readonly enabled: boolean;
    private readonly expectedHash: Buffer | null;

    constructor(envVarName = 'KOVAEL_API_TOKEN', env: NodeJS.ProcessEnv = process.env) {
        const raw = env[envVarName];
        const allowUnauthenticated = env.KOVAEL_ALLOW_UNAUTHENTICATED === 'true';
        if (raw && raw.length > 0) {
            this.enabled = true;
            this.expectedHash = crypto.createHash('sha256').update(raw, 'utf8').digest();
        } else {
            this.enabled = !allowUnauthenticated;
            this.expectedHash = null;
        }
    }

    /**
     * Returns true iff the request is allowed through. Explicitly disabled →
     * always true. Enabled with no configured token → deny. Enabled with a
     * token → hash and compare in constant time, regardless of length.
     */
    public verify(req: IncomingMessage, options: { allowQueryToken?: boolean } = {}): boolean {
        if (!this.enabled) return true;
        if (this.expectedHash === null) return false;

        const presented = this.presentedToken(req, options.allowQueryToken === true);
        if (typeof presented !== 'string') return false;

        const presentedHash = crypto.createHash('sha256').update(presented, 'utf8').digest();
        return crypto.timingSafeEqual(presentedHash, this.expectedHash);
    }

    private presentedToken(req: IncomingMessage, allowQueryToken: boolean): string | null {
        const header = req.headers['authorization'];
        const prefix = 'Bearer ';
        if (typeof header === 'string' && header.startsWith(prefix)) {
            return header.slice(prefix.length);
        }

        if (!allowQueryToken) return null;
        try {
            const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
            return url.searchParams.get('token');
        } catch {
            return null;
        }
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
