import crypto from 'node:crypto';

const SECURITY_VERSION = 'kovael-chair-v1';
const ENCRYPTION_ALG = 'A256GCM';
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export const CHAIR_DISPATCH_SECRET_ENV = 'KOVAEL_CHAIR_DISPATCH_SECRET';
export const CHAIR_DISPATCH_SECURITY_HEADER = 'x-kovael-chair-security';

export interface ChairDispatchEnvelope {
    version: typeof SECURITY_VERSION;
    encrypted: true;
    alg: typeof ENCRYPTION_ALG;
    requestId: string;
    timestamp: number;
    iv: string;
    ciphertext: string;
    tag: string;
}

export class ChairDispatchSecurityError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

function currentSecret(): string | null {
    const value = process.env[CHAIR_DISPATCH_SECRET_ENV]?.trim();
    return value && value.length >= 32 ? value : null;
}

function keyFor(secret: string): Buffer {
    return crypto
        .createHash('sha256')
        .update(`${SECURITY_VERSION}:payload:`)
        .update(secret)
        .digest();
}

function aadFor(requestId: string, timestamp: number): Buffer {
    return Buffer.from(`${SECURITY_VERSION}\n${requestId}\n${timestamp}`, 'utf8');
}

function b64(value: Buffer): string {
    return value.toString('base64url');
}

function fromB64(value: unknown, field: string): Buffer {
    if (typeof value !== 'string' || value.length === 0) {
        throw new ChairDispatchSecurityError(400, 'invalid_chair_dispatch_envelope', `${field} is required`);
    }
    try {
        return Buffer.from(value, 'base64url');
    } catch {
        throw new ChairDispatchSecurityError(400, 'invalid_chair_dispatch_envelope', `${field} is invalid`);
    }
}

function asEnvelope(body: Record<string, unknown>): ChairDispatchEnvelope {
    const timestamp = body.timestamp;
    if (
        body.version !== SECURITY_VERSION ||
        body.encrypted !== true ||
        body.alg !== ENCRYPTION_ALG ||
        typeof body.requestId !== 'string' ||
        body.requestId.length === 0 ||
        typeof timestamp !== 'number' ||
        !Number.isFinite(timestamp)
    ) {
        throw new ChairDispatchSecurityError(400, 'invalid_chair_dispatch_envelope', 'encrypted chair payload is malformed');
    }

    const age = Math.abs(Date.now() - timestamp);
    if (age > MAX_CLOCK_SKEW_MS) {
        throw new ChairDispatchSecurityError(401, 'stale_chair_dispatch_envelope', 'encrypted chair payload timestamp is outside the allowed window');
    }

    return {
        version: SECURITY_VERSION,
        encrypted: true,
        alg: ENCRYPTION_ALG,
        requestId: body.requestId,
        timestamp,
        iv: String(body.iv ?? ''),
        ciphertext: String(body.ciphertext ?? ''),
        tag: String(body.tag ?? ''),
    };
}

export function chairDispatchSecurityEnabled(): boolean {
    return currentSecret() !== null;
}

export function secureChairDispatchBody(payload: Record<string, unknown>, requestId: string): {
    body: string;
    headers: Record<string, string>;
} {
    const secret = currentSecret();
    if (!secret) {
        return {
            body: JSON.stringify(payload),
            headers: { 'content-type': 'application/json' },
        };
    }

    const timestamp = Date.now();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(secret), iv);
    cipher.setAAD(aadFor(requestId, timestamp));
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const body = JSON.stringify({
        version: SECURITY_VERSION,
        encrypted: true,
        alg: ENCRYPTION_ALG,
        requestId,
        timestamp,
        iv: b64(iv),
        ciphertext: b64(ciphertext),
        tag: b64(tag),
    } satisfies ChairDispatchEnvelope);

    return {
        body,
        headers: {
            'content-type': 'application/json',
            [CHAIR_DISPATCH_SECURITY_HEADER]: SECURITY_VERSION,
            'x-kovael-request-id': requestId,
        },
    };
}

export function openChairDispatchBody(body: Record<string, unknown>): Record<string, unknown> {
    const secret = currentSecret();
    if (!secret) return body;
    if (body.encrypted !== true) {
        throw new ChairDispatchSecurityError(401, 'chair_dispatch_security_required', 'encrypted chair payload is required');
    }

    const envelope = asEnvelope(body);
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(secret), fromB64(envelope.iv, 'iv'));
        decipher.setAAD(aadFor(envelope.requestId, envelope.timestamp));
        decipher.setAuthTag(fromB64(envelope.tag, 'tag'));
        const plaintext = Buffer.concat([
            decipher.update(fromB64(envelope.ciphertext, 'ciphertext')),
            decipher.final(),
        ]).toString('utf8');
        const parsed = JSON.parse(plaintext) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new ChairDispatchSecurityError(400, 'invalid_chair_dispatch_payload', 'decrypted chair payload is not an object');
        }
        return parsed as Record<string, unknown>;
    } catch (err) {
        if (err instanceof ChairDispatchSecurityError) throw err;
        throw new ChairDispatchSecurityError(401, 'invalid_chair_dispatch_ciphertext', 'encrypted chair payload authentication failed');
    }
}
