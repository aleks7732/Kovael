// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { AgentAvatarFallback } from '../../src/components/AgentAvatarFallback';

describe('AgentAvatarFallback', () => {
    afterEach(() => cleanup());

    it('renders an svg labelled with the agent id', () => {
        render(<AgentAvatarFallback agentId="nyx-codex" />);
        const svg = screen.getByLabelText(/avatar fallback for nyx-codex/i);
        expect(svg.tagName.toLowerCase()).toBe('svg');
    });

    it('strips a leading "nyx-" prefix to compute initials', () => {
        const { container } = render(<AgentAvatarFallback agentId="nyx-codex" />);
        const text = container.querySelector('text');
        // "nyx-codex" → "codex" → first two chars → "CO"
        expect(text?.textContent).toBe('CO');
    });

    it('uses the agentId as initials when no nyx- prefix is present', () => {
        const { container } = render(<AgentAvatarFallback agentId="shaev" />);
        expect(container.querySelector('text')?.textContent).toBe('SH');
    });

    it('produces deterministic output for the same agentId (seed stability)', () => {
        const { container: a } = render(<AgentAvatarFallback agentId="nyx-antigravity" />);
        const svgA = a.querySelector('svg')?.outerHTML ?? '';
        cleanup();
        const { container: b } = render(<AgentAvatarFallback agentId="nyx-antigravity" />);
        const svgB = b.querySelector('svg')?.outerHTML ?? '';
        // The gradient id includes the hash → if the hash function is
        // deterministic per agentId the entire serialized SVG should match.
        expect(svgA).toBe(svgB);
    });

    it('produces visually distinct gradients for different agentIds', () => {
        // Ten unique agent ids should yield at least three distinct hue1
        // values. Anything less means the hash collapses too aggressively
        // and the cockpit will show duplicate fallbacks.
        const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
        const stops = new Set<string>();
        for (const id of ids) {
            cleanup();
            const { container } = render(<AgentAvatarFallback agentId={id} />);
            const stop = container.querySelector('linearGradient > stop')?.getAttribute('stop-color') ?? '';
            stops.add(stop);
        }
        expect(stops.size).toBeGreaterThanOrEqual(3);
    });

    it('respects the size prop', () => {
        render(<AgentAvatarFallback agentId="nyx-cli" size={64} />);
        const svg = screen.getByLabelText(/avatar fallback for nyx-cli/i);
        expect(svg.getAttribute('width')).toBe('64');
        expect(svg.getAttribute('height')).toBe('64');
    });

    it('default size is 36', () => {
        render(<AgentAvatarFallback agentId="shaev" />);
        const svg = screen.getByLabelText(/avatar fallback for shaev/i);
        expect(svg.getAttribute('width')).toBe('36');
        expect(svg.getAttribute('height')).toBe('36');
    });
});
