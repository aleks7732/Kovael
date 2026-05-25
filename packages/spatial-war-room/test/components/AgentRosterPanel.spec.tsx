// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { AgentRosterPanel } from '../../src/components/AgentRosterPanel';
import type { AgentHubHealth, AgentRosterCard, AgentRuntimeSnapshot, HardwareTelemetry } from '../../src/store/useWarRoomStore';

afterEach(() => cleanup());

function card(id: string, overrides: Partial<AgentRosterCard> = {}): AgentRosterCard {
    return {
        id,
        name: id,
        provider: 'Test · Provider',
        status: 'online',
        ...overrides,
    };
}

const defaultProps = {
    rateLimits: {},
    interAgentChatEnabled: false,
    interAgentChatMode: 'interests' as const,
    interAgentMessages: [],
    onToggleInterAgentChat: () => {},
    onChangeInterAgentChatMode: () => {},
};

// Fixtures populate every required HardwareTelemetry field so tsc and the
// component contract stay in sync. timestamp + usedMb are derived from the
// other numbers; if production telemetry ever adds another required field
// these fixtures will fail tsc and we'll know to update them.
const HARDWARE_OK: HardwareTelemetry = {
    status: 'ok',
    timestamp: 1_779_262_000_000,
    freeMb: 12_000,
    usedMb: 12_000,
    totalMb: 24_000,
    utilizationPct: 50,
    devices: 1,
};

const HARDWARE_GATED: HardwareTelemetry = {
    status: 'ok',
    timestamp: 1_779_262_000_000,
    freeMb: 4_000,
    usedMb: 20_000,
    totalMb: 24_000,
    utilizationPct: 90,
    devices: 1,
};

describe('AgentRosterPanel', () => {
    it('shows the empty placeholder when the roster is empty', () => {
        render(<AgentRosterPanel {...defaultProps} roster={[]} hardware={null} />);
        expect(screen.getByText(/NO_AGENTS_REGISTERED/)).toBeTruthy();
    });

    it('renders one card per roster entry and badges the header count', () => {
        const roster = [
            card('nyx-antigravity', { name: 'Nyx-Antigravity' }),
            card('shaev',           { name: 'Shaev' }),
            card('nyx-codex',       { name: 'Nyx-Codex' }),
        ];
        render(<AgentRosterPanel {...defaultProps} roster={roster} hardware={null} />);
        expect(screen.getByText('Nyx-Antigravity')).toBeTruthy();
        expect(screen.getByText('Shaev')).toBeTruthy();
        expect(screen.getByText('Nyx-Codex')).toBeTruthy();
        // The roster count chip in the header should read "3"
        const headerChip = screen.getAllByText('3').find((el) => el.className.includes('command-accent'));
        expect(headerChip).toBeTruthy();
    });

    it('shows the UNCLAIMED beacon pill when an agent has no live chair', () => {
        render(<AgentRosterPanel {...defaultProps} roster={[card('shaev')]} hardware={null} />);
        expect(screen.getByText('UNCLAIMED')).toBeTruthy();
    });

    it('shows a LIVE pill when an agent has a fresh chair beacon', () => {
        const c = card('shaev', {
            chair: { sessionId: 'sess-1', claimedAt: Date.now() - 1000, lastBeaconAt: Date.now() - 1000, presence: 'live' },
        });
        render(<AgentRosterPanel {...defaultProps} roster={[c]} hardware={null} />);
        expect(screen.getByText(/LIVE/)).toBeTruthy();
    });

    it('keeps the live chair beacon out of the agent name row', () => {
        const c = card('nyx-codex', {
            name: 'Nyx-Codex',
            trust_tier: 2,
            chair: { sessionId: 'sess-1', claimedAt: Date.now() - 1000, lastBeaconAt: Date.now() - 1000, presence: 'live' },
        });
        render(<AgentRosterPanel {...defaultProps} roster={[c]} hardware={null} width={180} />);

        const nameRow = screen.getByText('Nyx-Codex').closest('[data-roster-name-row]');
        const beaconRow = screen.getByText(/LIVE/).closest('[data-roster-beacon-row]');

        expect(nameRow).toBeTruthy();
        expect(beaconRow).toBeTruthy();
        expect(nameRow).not.toBe(beaconRow);
    });

    it('shows the rate-limit pill with inWindow/capacity tally', () => {
        const c = card('nyx-antigravity', { name: 'Nyx-Antigravity' });
        render(
            <AgentRosterPanel
                {...defaultProps}
                roster={[c]}
                hardware={null}
                rateLimits={{
                    'nyx-antigravity': {
                        agentId: 'nyx-antigravity',
                        inWindow: 7,
                        capacity: 60,
                        windowMs: 60_000,
                        blocked: false,
                    },
                }}
            />,
        );
        expect(screen.getByText(/7\/60/)).toBeTruthy();
    });

    it('renders trust-tier abbreviations and the full label as tooltip', () => {
        const c = card('shaev', { name: 'Shaev', trust_tier: 3 });
        render(<AgentRosterPanel {...defaultProps} roster={[c]} hardware={null} />);
        // "T3" abbreviation chip
        expect(screen.getByText('T3')).toBeTruthy();
        // "Tier 3 · Local" full label visible somewhere on the card footer
        expect(screen.getByText(/Tier 3 · Local/)).toBeTruthy();
    });

    it('renders the MCP capability chips, truncated to the first six', () => {
        const c = card('nyx-codex', {
            mcp_capabilities: ['filesystem', 'git', 'shell', 'docker', 'python', 'bash', 'overflow-one', 'overflow-two'],
        });
        render(<AgentRosterPanel {...defaultProps} roster={[c]} hardware={null} />);
        expect(screen.getByText('filesystem')).toBeTruthy();
        expect(screen.getByText('git')).toBeTruthy();
        expect(screen.getByText('bash')).toBeTruthy();
        // The 7th and 8th items are clipped (component slices at 6)
        expect(screen.queryByText('overflow-one')).toBeNull();
        expect(screen.queryByText('overflow-two')).toBeNull();
    });

    it('toggles BANTER on click and surfaces the new state to the callback', () => {
        const onToggle = vi.fn();
        const { container } = render(
            <AgentRosterPanel {...defaultProps} roster={[]} hardware={null} onToggleInterAgentChat={onToggle} />,
        );
        // The BANTER toggle is a small button next to the eyebrow text. The
        // toggle pill has a known w-7 h-4 shape — we just click *some*
        // button that's adjacent to the BANTER label.
        const banter = screen.getByText('BANTER');
        const wrapper = banter.closest('div');
        const toggle = wrapper?.querySelector('button');
        expect(toggle).toBeTruthy();
        fireEvent.click(toggle!);
        expect(onToggle).toHaveBeenCalledWith(true);
        // Verifies parent isn't capturing/preventing
        void container;
    });

    it('shows the BANTER stream pane only when interAgentChatEnabled is true', () => {
        const { rerender } = render(
            <AgentRosterPanel {...defaultProps} roster={[card('shaev')]} hardware={null} />,
        );
        expect(screen.queryByText('SOVEREIGN_BANTER_STREAM')).toBeNull();

        rerender(
            <AgentRosterPanel
                {...defaultProps}
                roster={[card('shaev')]}
                hardware={null}
                interAgentChatEnabled={true}
            />,
        );
        expect(screen.getByText('SOVEREIGN_BANTER_STREAM')).toBeTruthy();
    });

    it('mode switcher in the BANTER pane fires the right callback', () => {
        const onChangeMode = vi.fn();
        render(
            <AgentRosterPanel
                {...defaultProps}
                roster={[card('shaev')]}
                hardware={null}
                interAgentChatEnabled={true}
                interAgentChatMode="interests"
                onChangeInterAgentChatMode={onChangeMode}
            />,
        );
        const techBtn = screen.getByRole('button', { name: 'TECHNICAL' });
        fireEvent.click(techBtn);
        expect(onChangeMode).toHaveBeenCalledWith('technical');
    });

    it('hardware gauge: shows "awaiting telemetry" when no metrics yet', () => {
        render(<AgentRosterPanel {...defaultProps} roster={[]} hardware={null} />);
        expect(screen.getByText(/awaiting telemetry/i)).toBeTruthy();
    });

    it('hardware gauge: SHAEV_GATE reads AUTHORIZED when freeMb ≥ 8 GiB', () => {
        render(<AgentRosterPanel {...defaultProps} roster={[]} hardware={HARDWARE_OK} />);
        expect(screen.getByText('AUTHORIZED')).toBeTruthy();
    });

    it('hardware gauge: SHAEV_GATE flips to GATED when freeMb < 8 GiB', () => {
        render(<AgentRosterPanel {...defaultProps} roster={[]} hardware={HARDWARE_GATED} />);
        expect(screen.getByText(/GATED → NYX-CLI/)).toBeTruthy();
    });

    it('hardware gauge: shows free / total in GB to one decimal', () => {
        render(<AgentRosterPanel {...defaultProps} roster={[]} hardware={HARDWARE_OK} />);
        // 12000 / 1024 = 11.71875 → ".7 / 23 GB"
        // The component renders "11.7 / 23 GB"; match loosely on the number.
        expect(screen.getByText(/11\.7\s*\/\s*23\s*GB/i)).toBeTruthy();
    });

    it('shows managed runtime controls, state, pid, and hub health for a running agent', () => {
        const onLifecycleAction = vi.fn();
        const runtimes: AgentRuntimeSnapshot = {
            enabled: true,
            parkOnIdle: true,
            configured: 1,
            running: 1,
            updatedAt: 1779262000000,
            agents: {
                shaev: {
                    agentId: 'shaev',
                    runtime: 'claude-shaev',
                    running: true,
                    pid: 4242,
                    hubPath: 'I:\\Kovael\\.kovael\\agents\\shaev\\agent-hub.sqlite',
                    status: 'running',
                    managed: true,
                },
            },
        };
        const hubHealthByAgent: Record<string, AgentHubHealth> = {
            shaev: {
                agentId: 'shaev',
                status: 'ok',
                dispatches: 3,
                running: 1,
                succeeded: 2,
                failed: 0,
                memories: 4,
                checkedAt: 1779262020000,
            },
        };

        render(
            <AgentRosterPanel
                {...defaultProps}
                roster={[card('shaev', { name: 'Shaev' })]}
                hardware={null}
                agentRuntimes={runtimes}
                hubHealthByAgent={hubHealthByAgent}
                pendingLifecycleActions={{}}
                lifecycleErrors={{}}
                onLifecycleAction={onLifecycleAction}
            />,
        );

        expect(screen.getByText('RUNNING')).toBeTruthy();
        expect(screen.getByText('PID 4242')).toBeTruthy();
        expect(screen.getByText('HUB OK')).toBeTruthy();
        expect(screen.getByTitle(/3 dispatches/i)).toBeTruthy();

        const start = screen.getByRole('button', { name: /^Start Shaev$/i }) as HTMLButtonElement;
        const stop = screen.getByRole('button', { name: /^Stop Shaev$/i }) as HTMLButtonElement;
        const restart = screen.getByRole('button', { name: /^Restart Shaev$/i }) as HTMLButtonElement;
        expect(start.disabled).toBe(true);
        expect(stop.disabled).toBe(false);
        expect(restart.disabled).toBe(false);

        fireEvent.click(stop);
        expect(onLifecycleAction).toHaveBeenCalledWith('shaev', 'stop');
    });

    it('surfaces lifecycle errors and disabled reasons without color-only state', () => {
        const runtimes: AgentRuntimeSnapshot = {
            enabled: false,
            parkOnIdle: true,
            configured: 0,
            running: 0,
            updatedAt: 1779262000000,
            agents: {},
        };

        render(
            <AgentRosterPanel
                {...defaultProps}
                roster={[card('nyx-codex', { name: 'Nyx-Codex' })]}
                hardware={null}
                agentRuntimes={runtimes}
                hubHealthByAgent={{}}
                pendingLifecycleActions={{}}
                lifecycleErrors={{ 'nyx-codex': 'spawn failed' }}
                onLifecycleAction={() => {}}
            />,
        );

        expect(screen.getByText('UNMANAGED')).toBeTruthy();
        expect(screen.getByText(/spawn failed/i)).toBeTruthy();
        const start = screen.getByRole('button', { name: /^Start Nyx-Codex$/i }) as HTMLButtonElement;
        expect(start.disabled).toBe(true);
        expect(start.getAttribute('title')).toMatch(/lifecycle supervision is disabled/i);
    });
});
