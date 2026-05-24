// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { StoppingCard } from '../../src/components/theater/StoppingCard';
import { TraceBreadcrumb } from '../../src/components/theater/TraceBreadcrumb';
import { areStagePropsEqual, Stage } from '../../src/components/theater/Stage';
import { ShortcutSheet } from '../../src/components/theater/ShortcutSheet';
import { CommitteeDrawer } from '../../src/components/theater/CommitteeDrawer';
import { ComfyMixerPanel } from '../../src/components/theater/ComfyMixerPanel';
import { useWarRoomStore, type AgentRosterCard } from '../../src/store/useWarRoomStore';
import fs from 'fs';
import path from 'path';

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// StoppingCard — renders the consensus banner when adaptive stability fires.
// ---------------------------------------------------------------------------
describe('StoppingCard', () => {
    it('returns null when no criterion is supplied (no banner spam pre-convene)', () => {
        const { container } = render(<StoppingCard criterion={null} />);
        expect(container.firstChild).toBeNull();
    });

    it('renders the verifier mention from the criterion payload', () => {
        render(
            <StoppingCard
                criterion={{
                    agentId: 'shaev',
                    reason: 'adaptive_stability_reached:delta=0.0392<0.05',
                    confidence: 0.82,
                }}
            />,
        );
        expect(screen.getByText('VERIFIER CONSENSUS REACHED')).toBeTruthy();
        // The verifier mention renders inside the prose, NOT as a bare span,
        // so we match on a substring instead of an exact text node.
        const banner = screen.getByText(/recorded a stable stopping condition/i);
        expect(banner.textContent).toContain('@shaev');
    });

    it('formats the confidence as a rounded percentage (0..100)', () => {
        render(
            <StoppingCard criterion={{ agentId: 'shaev', reason: 'adaptive_stability_reached:x', confidence: 0.8245 }} />,
        );
        expect(screen.getByText(/CONFIDENCE:\s*82%/)).toBeTruthy();
    });

    it('labels adaptive-stability metric distinctly from a hard-cap stop', () => {
        render(
            <StoppingCard criterion={{ agentId: 'shaev', reason: 'adaptive_stability_reached:delta=0.04', confidence: 0.9 }} />,
        );
        expect(screen.getByText(/ADAPTIVE STABILITY \(arXiv 2510\.12697\)/)).toBeTruthy();
    });

    it('shows ROUND TIMEOUT when the stop came from the hard cap', () => {
        render(
            <StoppingCard criterion={{ agentId: 'nyx-cli', reason: 'hard_cap_reached:rounds=6', confidence: 0.4 }} />,
        );
        expect(screen.getByText(/ROUND TIMEOUT/)).toBeTruthy();
    });

    it('humanises the rationale prefix so the operator sees prose, not snake_case', () => {
        render(
            <StoppingCard
                criterion={{ agentId: 'shaev', reason: 'adaptive_stability_reached:delta=0.04<0.05', confidence: 0.7 }}
            />,
        );
        // The mangled prefix gets rewritten to a human label
        expect(screen.getByText(/Adaptive Stability Met:/)).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// TraceBreadcrumb — verifies the trace timeline launch event contract.
// ---------------------------------------------------------------------------
describe('TraceBreadcrumb', () => {
    it('renders the OTEL TRACE pill with the topic id as title text', () => {
        render(<TraceBreadcrumb topicId="topic-abcd-1234" />);
        const pill = screen.getByText('OTEL TRACE').closest('div');
        expect(pill).toBeTruthy();
        expect(pill!.getAttribute('title')).toContain('topic-abcd-1234');
    });

    it('dispatches a trace-open event on click', () => {
        const spy = vi.fn();
        window.addEventListener('kovael:open-trace', spy);
        render(<TraceBreadcrumb topicId="topic-xyz" />);
        const pill = screen.getByText('OTEL TRACE');
        fireEvent.click(pill);
        expect(spy).toHaveBeenCalledTimes(1);
        expect((spy.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ topicId: 'topic-xyz' });
        window.removeEventListener('kovael:open-trace', spy);
    });
});

describe('ShortcutSheet', () => {
    it('renders as a dismissible keyboard dialog', () => {
        const onClose = vi.fn();
        render(<ShortcutSheet open={true} onClose={onClose} />);
        expect(screen.getByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeTruthy();

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not render while closed', () => {
        const { container } = render(<ShortcutSheet open={false} onClose={() => {}} />);
        expect(container.firstChild).toBeNull();
    });
});

describe('CommitteeDrawer', () => {
    it('renders active verdict, circuit state, and self-heal events', () => {
        useWarRoomStore.setState({
            committeeVerdicts: {
                t1: {
                    id: 'v1',
                    status: 'accepted',
                    supportScore: 0.91,
                    confidenceMean: 0.88,
                    sidecars: [],
                    dissent: [],
                    trace: { mergeParentId: 'merge-1', lanes: [{ laneId: 'lane-1' }] },
                },
            },
            committeeEvents: [
                {
                    type: 'committee.vote',
                    topicId: 't1',
                    receivedAt: 1,
                    vote: { agentId: 'shaev', role: 'judge', verdict: 'approve', confidence: 0.88, rationale: 'ok' },
                },
            ],
            chairCircuits: {
                shaev: { type: 'chair.circuit_open', agentId: 'shaev', state: 'open', failures: 3, timestamp: 1 },
            },
            selfHealEvents: [
                { type: 'self_heal.patch_applied', cycleId: 'c1', taskHash: 'h1', attempt: 1, timestamp: 1 },
            ],
        });

        render(<CommitteeDrawer topicId="t1" />);

        expect(screen.getByText('COMMITTEE')).toBeTruthy();
        expect(screen.getByText('accepted')).toBeTruthy();
        expect(screen.getByText(/shaev: approve 88%/)).toBeTruthy();
        expect(screen.getByText(/shaev: open/)).toBeTruthy();
        expect(screen.getByText(/patch_applied/)).toBeTruthy();
    });
});

describe('ComfyMixerPanel', () => {
    it('posts typed mixer payload and records fallback preview', async () => {
        const fetchSpy = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                agentId: 'nyx-codex',
                source: 'fallback',
                width: 1280,
                height: 720,
                mimeType: 'image/svg+xml',
                svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
                stream: { url: 'ws://evil.example/socket' },
            }),
        });
        vi.stubGlobal('fetch', fetchSpy);
        useWarRoomStore.setState({
            activeTopicId: 't1',
            topics: [{ id: 't1', title: 'Mixer Test', participants: ['nyx-codex'], active: true }],
            comfyPreviews: [],
        });

        render(<ComfyMixerPanel />);
        fireEvent.change(screen.getByLabelText('nyx strength'), { target: { value: '1.5' } });
        fireEvent.click(screen.getByText('RENDER'));
        await screen.findByAltText('nyx-codex preview');

        expect(fetchSpy).toHaveBeenCalledWith('http://localhost:8080/api/v1/comfy/mix', expect.objectContaining({
            method: 'POST',
        }));
        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body.mixer[0]).toMatchObject({ recipeId: 'nyx', strength: 1.5 });
        expect(useWarRoomStore.getState().comfyPreviews[0]).toMatchObject({ agentId: 'nyx-codex', source: 'fallback' });
        expect(useWarRoomStore.getState().comfyPreviews[0].streamUrl).toBeUndefined();
        vi.unstubAllGlobals();
    });
});

describe('WarRoom trace reroute store action', () => {
    it('posts sanitized ReactFlow drag connections to reroute endpoint', () => {
        const fetchSpy = vi.fn().mockResolvedValue(new Response('{}'));
        vi.stubGlobal('fetch', fetchSpy);
        useWarRoomStore.setState({ edges: [] });

        useWarRoomStore.getState().onConnect({
            source: 'agent.a',
            target: 'trace:b',
            sourceHandle: 'out',
            targetHandle: 'in',
        });

        expect(fetchSpy).toHaveBeenCalledWith('http://localhost:8080/api/v1/traces/reroute', expect.objectContaining({
            method: 'POST',
        }));
        const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(body).toEqual({ source: 'agent.a', target: 'trace:b', sourceHandle: 'out', targetHandle: 'in' });
        expect(useWarRoomStore.getState().edges).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Stage — the round-table layout. Tests cover empty-roster, single seat,
// active-speaker highlight, name label, and the live-chair beacon dot.
// ---------------------------------------------------------------------------

function makeCard(id: string, overrides: Partial<AgentRosterCard> = {}): AgentRosterCard {
    return {
        id,
        name: id,
        provider: 'test',
        status: 'online',
        ...overrides,
    };
}

describe('Stage', () => {
    it('renders no seats but keeps the table core for an empty roster', () => {
        render(<Stage roster={[]} activeSpeakerId={null} />);
        expect(screen.getByText('STANDBY')).toBeTruthy();
    });

    it('switches the core to CONVENING when there is an active speaker', () => {
        render(
            <Stage
                roster={[makeCard('nyx-antigravity', { name: 'Nyx-Antigravity' })]}
                activeSpeakerId="nyx-antigravity"
            />,
        );
        expect(screen.getByText('CONVENING')).toBeTruthy();
    });

    it('caps the visible seating at 9 even when more agents are on the roster', () => {
        const ten = Array.from({ length: 10 }, (_, i) => makeCard(`agent-${i}`));
        const { container } = render(<Stage roster={ten} activeSpeakerId={null} />);
        // Each rendered seat carries the agent's display name in a label
        // chip; the table core itself is NOT a seat. Count seat name chips.
        const seatLabels = container.querySelectorAll('.max-w-\\[80px\\]');
        expect(seatLabels.length).toBe(9);
    });

    it('shows only the selected topic participants when participantIds are provided', () => {
        const { container } = render(
            <Stage
                roster={[
                    makeCard('nyx-codex', { name: 'nyx-codex' }),
                    makeCard('shaev', { name: 'Shaev' }),
                    makeCard('nyx-openclaw', { name: 'nyx-openclaw' }),
                    makeCard('nyx-cli', { name: 'nyx-cli' }),
                ]}
                participantIds={['nyx-codex', 'shaev', 'nyx-openclaw']}
                activeSpeakerId={null}
            />,
        );

        const labels = Array.from(container.querySelectorAll('.max-w-\\[80px\\] span:first-child')).map(
            (node) => node.textContent?.trim(),
        );
        expect(labels).toEqual(['codex', 'openclaw', 'Shaev']);
        expect(screen.queryByText('cli')).toBeNull();
    });

    it('strips the nyx- prefix from the display name chip', () => {
        render(
            <Stage
                roster={[makeCard('nyx-codex', { name: 'nyx-codex' })]}
                activeSpeakerId={null}
            />,
        );
        // The label chip should show 'codex', not 'nyx-codex'
        expect(screen.getByText('codex')).toBeTruthy();
    });

    it('renders the avatar image when portrait_url is supplied', () => {
        render(
            <Stage
                roster={[makeCard('nyx-antigravity', { name: 'Nyx-Antigravity', portrait_url: '/agents/nyx-antigravity.png' })]}
                activeSpeakerId={null}
            />,
        );
        const img = screen.getByAltText('Nyx-Antigravity') as HTMLImageElement;
        expect(img.tagName.toLowerCase()).toBe('img');
        expect(img.getAttribute('src')).toBe('/agents/nyx-antigravity.png');
    });

    it('falls back to the SVG identity avatar when no portrait_url is given', () => {
        const { container } = render(
            <Stage
                roster={[makeCard('newcomer', { name: 'newcomer' })]}
                activeSpeakerId={null}
            />,
        );
        // AgentAvatarFallback renders an <svg> with aria-label
        const svg = container.querySelector('svg[aria-label*="newcomer"]');
        expect(svg).not.toBeNull();
    });

    it('shows the live-chair beacon dot in emerald when chair.presence is live', () => {
        const { container } = render(
            <Stage
                roster={[
                    makeCard('nyx-cli', {
                        chair: { sessionId: 's1', claimedAt: 1, lastBeaconAt: Date.now(), presence: 'live' },
                    }),
                ]}
                activeSpeakerId={null}
            />,
        );
        const dot = container.querySelector('span[title^="Chair Status: Live"]');
        expect(dot).not.toBeNull();
    });

    it('places seats in deterministic alphabetical order around the table', () => {
        const { container } = render(
            <Stage
                roster={[
                    makeCard('zeta'),
                    makeCard('alpha'),
                    makeCard('mu'),
                ]}
                activeSpeakerId={null}
            />,
        );
        const labels = Array.from(container.querySelectorAll('.max-w-\\[80px\\] span:first-child')).map(
            (n) => n.textContent,
        );
        // Stage sorts by id locale-compare → alpha, mu, zeta
        expect(labels).toEqual(['alpha', 'mu', 'zeta']);
    });

    it('treats equivalent roster snapshots as equal to avoid telemetry-loop re-renders', () => {
        const first = [
            makeCard('nyx-codex', { accent_hex: '#7c3aed' }),
            makeCard('shaev', { accent_hex: '#059669', chair: { sessionId: 's1', claimedAt: 1, lastBeaconAt: 2, presence: 'live' } }),
        ];
        const second = first.map((card) => ({
            ...card,
            chair: card.chair ? { ...card.chair } : undefined,
        }));

        expect(
            areStagePropsEqual(
                { roster: first, activeSpeakerId: 'shaev' },
                { roster: second, activeSpeakerId: 'shaev' },
            ),
        ).toBe(true);
        expect(
            areStagePropsEqual(
                { roster: first, activeSpeakerId: 'shaev' },
                { roster: second, activeSpeakerId: 'nyx-codex' },
            ),
        ).toBe(false);
    });

    it('guarantees stable rendering structure and does not rearrange order when properties are structurally equal', () => {
        const roster = [
            makeCard('gamma'),
            makeCard('beta'),
            makeCard('delta'),
        ];
        const { rerender, container } = render(
            <Stage roster={roster} activeSpeakerId={null} />
        );
        const firstOrder = Array.from(container.querySelectorAll('.max-w-\\[80px\\] span:first-child')).map(
            (n) => n.textContent?.trim(),
        );
        
        // Rerender with structurally equivalent roster
        const newRoster = [
            makeCard('gamma'),
            makeCard('beta'),
            makeCard('delta'),
        ];
        rerender(<Stage roster={newRoster} activeSpeakerId={null} />);
        const secondOrder = Array.from(container.querySelectorAll('.max-w-\\[80px\\] span:first-child')).map(
            (n) => n.textContent?.trim(),
        );
        
        expect(firstOrder).toEqual(secondOrder);
        expect(firstOrder).toEqual(['beta', 'delta', 'gamma']); // Alphabetical sorting is preserved
    });
});

describe('Vite Bundle Configuration', () => {
    it('asserts that bundle configuration enforces the 800KiB size limit', () => {
        const configPath = path.resolve(__dirname, '../../vite.config.ts');
        const content = fs.readFileSync(configPath, 'utf-8');
        expect(content).toContain('chunkSizeWarningLimit: 800');
        expect(content).toContain('manualChunks');
    });
});

