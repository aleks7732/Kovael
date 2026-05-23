import { describe, it, expect } from 'vitest';
import { generateANXTemplate } from '../protocols/ANX-Schema.js';

describe('generateANXTemplate', () => {
    it('returns a non-empty string', () => {
        expect(typeof generateANXTemplate()).toBe('string');
        expect(generateANXTemplate().trim().length).toBeGreaterThan(0);
    });

    it('contains the root <sop_container> element', () => {
        const tmpl = generateANXTemplate();
        expect(tmpl).toContain('<sop_container>');
        expect(tmpl).toContain('</sop_container>');
    });

    it('contains all four required top-level sections', () => {
        const tmpl = generateANXTemplate();
        const sections = [
            '<mission_manifest>',
            '<provenance>',
            '<success_criteria>',
            '<adversarial_critique>',
        ];
        for (const section of sections) {
            expect(tmpl, `missing section ${section}`).toContain(section);
        }
    });

    it('embeds a valid ISO-8601 timestamp in <provenance>', () => {
        const tmpl = generateANXTemplate();
        const match = tmpl.match(/<timestamp>([^<]+)<\/timestamp>/);
        expect(match).not.toBeNull();
        const ts = new Date(match![1]);
        expect(Number.isNaN(ts.getTime())).toBe(false);
    });

    it('contains <priority>medium</priority> as the default priority', () => {
        expect(generateANXTemplate()).toContain('<priority>medium</priority>');
    });

    it('contains version 1.0.0', () => {
        expect(generateANXTemplate()).toContain('<version>1.0.0</version>');
    });

    it('each call produces an independent template (no shared state)', () => {
        const t1 = generateANXTemplate();
        const t2 = generateANXTemplate();
        // Both are structurally identical — no shared mutable state.
        // Timestamps may differ by a millisecond; strip them before comparing.
        const strip = (s: string) => s.replace(/<timestamp>[^<]+<\/timestamp>/, '<timestamp/>');
        expect(strip(t1)).toBe(strip(t2));
    });
});
