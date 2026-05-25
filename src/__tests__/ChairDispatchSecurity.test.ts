import { afterEach, describe, expect, it } from 'vitest';
import {
    CHAIR_DISPATCH_SECRET_ENV,
    ChairDispatchSecurityError,
    openChairDispatchBody,
    secureChairDispatchBody,
} from '../services/ChairDispatchSecurity.js';

describe('ChairDispatchSecurity', () => {
    const originalSecret = process.env[CHAIR_DISPATCH_SECRET_ENV];

    afterEach(() => {
        if (originalSecret === undefined) {
            delete process.env[CHAIR_DISPATCH_SECRET_ENV];
        } else {
            process.env[CHAIR_DISPATCH_SECRET_ENV] = originalSecret;
        }
    });

    it('passes plain JSON through when no dispatch secret is configured', () => {
        delete process.env[CHAIR_DISPATCH_SECRET_ENV];

        const secured = secureChairDispatchBody({ agentId: 'nyx-codex', content: 'ok' }, 'req-1');
        const parsed = JSON.parse(secured.body) as Record<string, unknown>;

        expect(parsed).toEqual({ agentId: 'nyx-codex', content: 'ok' });
        expect(openChairDispatchBody(parsed)).toEqual(parsed);
    });

    it('encrypts and decrypts dispatch payloads when a secret is configured', () => {
        process.env[CHAIR_DISPATCH_SECRET_ENV] = '0123456789abcdef0123456789abcdef';

        const secured = secureChairDispatchBody({ agentId: 'shaev', content: 'private dispatch' }, 'req-2');
        const parsed = JSON.parse(secured.body) as Record<string, unknown>;

        expect(secured.body).not.toContain('private dispatch');
        expect(parsed.encrypted).toBe(true);
        expect(openChairDispatchBody(parsed)).toEqual({ agentId: 'shaev', content: 'private dispatch' });
    });

    it('rejects plaintext bodies when secure chair dispatch is enabled', () => {
        process.env[CHAIR_DISPATCH_SECRET_ENV] = 'abcdef0123456789abcdef0123456789';

        expect(() => openChairDispatchBody({ agentId: 'shaev', content: 'forged' }))
            .toThrow(ChairDispatchSecurityError);
    });
});
