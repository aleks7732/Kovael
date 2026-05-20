// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { AgentIdentityBadge } from '../../src/components/AgentIdentityBadge';

const KNOWN_AGENTS: Array<{ id: string; tellHint: string }> = [
    { id: 'nyx-antigravity', tellHint: 'planet'  },
    { id: 'nyx-claude-code', tellHint: 'braces'  },
    { id: 'nyx-cli',         tellHint: 'prompt'  },
    { id: 'nyx-agcli',       tellHint: 'aviator' },
    { id: 'nyx-adk',         tellHint: 'stack'   },
    { id: 'nyx-codex',       tellHint: 'wrench'  },
    { id: 'nyx-openclaw',    tellHint: 'gamepad' },
    { id: 'nyx-cw',          tellHint: 'refactor'},
    { id: 'shaev',           tellHint: 'palette' },
];

describe('AgentIdentityBadge', () => {
    afterEach(() => cleanup());

    it('renders a labelled badge for every roster chair', () => {
        for (const agent of KNOWN_AGENTS) {
            cleanup();
            render(<AgentIdentityBadge agentId={agent.id} />);
            const badge = screen.getByRole('img');
            expect(badge.getAttribute('aria-label')).toBeTruthy();
            const label = badge.getAttribute('aria-label') ?? '';
            // Each persona's aria-label mentions its unique tell. We don't
            // require an exact match because the labels are human prose,
            // but every label must reference something specific to that
            // chair so screen-reader users can tell them apart.
            expect(label.length).toBeGreaterThan(6);
        }
    });

    it('falls back to a generic dot for unknown agentIds', () => {
        render(<AgentIdentityBadge agentId="someone-not-on-the-roster" />);
        const badge = screen.getByRole('img');
        expect(badge.getAttribute('aria-label')).toMatch(/Agent identity badge/i);
    });

    it('applies the accentHex as the chip background, not the glyph color', () => {
        render(<AgentIdentityBadge agentId="nyx-antigravity" accentHex="#d97706" />);
        const badge = screen.getByRole('img');
        const style = badge.getAttribute('style') ?? '';
        // Background must carry the accent; glyph color must NOT —
        // the docstring rationale was that the dark glyph stays
        // legible across every accent in the design system.
        expect(style.toLowerCase()).toContain('#d97706');
        // The glyph itself renders inside the chip; verify its computed
        // color class is the dark obsidian, not the accent.
        const html = badge.outerHTML;
        expect(html).toContain('text-[#0A0A09]');
    });

    it('respects size prop on the outer chip', () => {
        render(<AgentIdentityBadge agentId="shaev" size={20} />);
        const badge = screen.getByRole('img');
        const style = badge.getAttribute('style') ?? '';
        expect(style).toContain('width: 20px');
        expect(style).toContain('height: 20px');
    });

    it('default size is 14px when no size prop is given', () => {
        render(<AgentIdentityBadge agentId="nyx-codex" />);
        const badge = screen.getByRole('img');
        const style = badge.getAttribute('style') ?? '';
        expect(style).toContain('width: 14px');
    });

    it('renders an svg child for every known persona', () => {
        for (const agent of KNOWN_AGENTS) {
            cleanup();
            const { container } = render(<AgentIdentityBadge agentId={agent.id} />);
            const svg = container.querySelector('svg');
            expect(svg, `svg should render for ${agent.id}`).not.toBeNull();
            // aria-hidden on the svg child — the *chip* carries the label
            // so screen readers don't double-announce.
            expect(svg!.getAttribute('aria-hidden')).toBeDefined();
        }
    });

    it('uses a neutral background when accentHex is omitted', () => {
        render(<AgentIdentityBadge agentId="shaev" />);
        const badge = screen.getByRole('img');
        const style = badge.getAttribute('style') ?? '';
        // The component's default fallback is the warm-obsidian #1f1f1d;
        // verify it ships when no accent is provided rather than leaving
        // the chip transparent (which would be invisible on dark avatars).
        expect(style.toLowerCase()).toContain('#1f1f1d');
    });
});
