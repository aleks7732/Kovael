import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..', '..');

describe('chair validation smoke scripts', () => {
    it('validate-all-chairs is strict by default and only allows fallbacks by explicit opt-out', () => {
        const script = readFileSync(path.join(root, 'scripts', 'validate-all-chairs.mjs'), 'utf8');

        expect(script).toContain('KOVAEL_ALLOW_CHAIR_FALLBACKS');
        expect(script).toContain("!== 'true'");
    });

    it('validate-all-chairs writes sanitized failure artifacts under .notes/chair-smoke', () => {
        const script = readFileSync(path.join(root, 'scripts', 'validate-all-chairs.mjs'), 'utf8');

        expect(script).toContain(".notes', 'chair-smoke'");
        expect(script).toContain('KOVAEL_RETAIN_SMOKE_ARTIFACTS');
        expect(script).toContain('sanitizeArtifact');
        expect(script).toMatch(/replyProofSecret\|replyProof\|authorization\|token\|secret/);
        expect(script).toMatch(/content\|delta\|text\|reply\|reason/);
    });

    it('validate-pr runs strict all-chair validation by default', () => {
        const script = readFileSync(path.join(root, 'scripts', 'validate-pr.mjs'), 'utf8');

        expect(script).toContain('all chairs validation');
        expect(script).toContain('KOVAEL_ALLOW_CHAIR_FALLBACKS');
        expect(script).not.toContain('KOVAEL_VALIDATE_ALL_CHAIRS');
        expect(script.indexOf('changed-file secret scan')).toBeLessThan(script.indexOf('all chairs validation'));
    });
});
