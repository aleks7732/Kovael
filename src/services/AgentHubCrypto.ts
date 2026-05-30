import crypto from 'node:crypto';
import { AGENT_HUB_SECRET_ENV } from './RuntimeSecurity.js';

const ENCRYPTED_VALUE_MARKER = '__kovaelEncrypted';
const ENCRYPTED_VALUE_VERSION = 1;
const ENCRYPTION_AAD_VERSION = 'kovael-agent-hub-field-v1';
const ENCRYPTION_ALG = 'A256GCM';

/**
 * Derive the per-hub AES-256 key from the configured secret and the stored
 * salt. The salt is persisted base64url; scrypt parameters are fixed so an
 * existing hub continues to derive the identical key on every boot.
 */
export function deriveEncryptionKey(secret: string, salt: string): Buffer {
    return crypto.scryptSync(secret, Buffer.from(salt, 'base64url'), 32);
}

/**
 * Compute the additional authenticated data string bound to a given
 * table/id/column triple. The exact byte layout is part of the on-disk
 * envelope contract — changing it would break decryption of existing rows.
 */
export function aadFor(table: string, id: string, column: string): string {
    return `${ENCRYPTION_AAD_VERSION}\n${table}\n${id}\n${column}`;
}

/**
 * Encrypt a sensitive field value into the JSON envelope persisted on disk.
 * When no key is configured the value is passed through unchanged, matching
 * the plaintext-storage behaviour of an unencrypted hub.
 */
export function sealSensitive(key: Buffer | null, value: string, aad: string): string {
    if (!key) return value;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(value, 'utf8')),
        cipher.final(),
    ]);
    return JSON.stringify({
        [ENCRYPTED_VALUE_MARKER]: true,
        v: ENCRYPTED_VALUE_VERSION,
        alg: ENCRYPTION_ALG,
        iv: iv.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
    });
}

/**
 * Decrypt a stored field value. A non-envelope value is returned verbatim
 * (legacy plaintext rows). An envelope requires the hub secret to be present.
 */
export function openSensitive(key: Buffer | null, value: string, aad: string): string {
    const envelope = parseEncryptedEnvelope(value);
    if (!envelope) return value;
    if (!key) {
        throw new Error(`encrypted agent hub value requires ${AGENT_HUB_SECRET_ENV}`);
    }
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(envelope.iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
        decipher.final(),
    ]).toString('utf8');
}

export function parseEncryptedEnvelope(value: string): {
    iv: string;
    ciphertext: string;
    tag: string;
} | null {
    try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        if (
            parsed?.[ENCRYPTED_VALUE_MARKER] === true &&
            parsed.v === ENCRYPTED_VALUE_VERSION &&
            parsed.alg === ENCRYPTION_ALG &&
            typeof parsed.iv === 'string' &&
            typeof parsed.ciphertext === 'string' &&
            typeof parsed.tag === 'string'
        ) {
            return {
                iv: parsed.iv,
                ciphertext: parsed.ciphertext,
                tag: parsed.tag,
            };
        }
    } catch {
        return null;
    }
    return null;
}
