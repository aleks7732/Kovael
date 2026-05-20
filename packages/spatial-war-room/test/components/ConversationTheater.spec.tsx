// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConversationTheater } from '../../src/components/theater/ConversationTheater';
import { useWarRoomStore } from '../../src/store/useWarRoomStore';
import type { AgentRosterCard, ConversationMessage, ConversationTopic } from '../../src/store/useWarRoomStore';

// happy-dom omits scrollIntoView; MessageList calls it on every render.
beforeEach(() => {
    if (typeof window !== 'undefined') {
        Element.prototype.scrollIntoView = vi.fn();
    }
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // Reset the Zustand singleton between tests so seeded state from one
    // case can't bleed into a sibling. We only zero out the fields the
    // theater reads — leave the rest of the store at its initial values
    // (the store has many fields the test doesn't care about).
    useWarRoomStore.setState({
        topics: [],
        messagesByTopic: {},
        conversationStoppingCriterion: {},
        activeTopicId: null,
        agentRoster: [],
    } as any);
});

function makeCard(id: string, overrides: Partial<AgentRosterCard> = {}): AgentRosterCard {
    return { id, name: id, provider: 'test', status: 'online', ...overrides };
}

function makeTopic(overrides: Partial<ConversationTopic> = {}): ConversationTopic {
    return {
        id: overrides.id ?? 't-' + Math.random().toString(36).slice(2, 8),
        title: 'design retry policy',
        participants: ['nyx-antigravity', 'shaev'],
        active: true,
        ...overrides,
    };
}

function makeMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
    return {
        id: 'm-' + Math.random().toString(36).slice(2, 8),
        topicId: 't1',
        senderId: 'nyx-antigravity',
        role: 'assistant',
        content: 'mesh state nominal',
        timestamp: Date.UTC(2026, 4, 20, 7, 30, 0),
        ...overrides,
    };
}

function seed(state: Partial<{
    topics: ConversationTopic[];
    messagesByTopic: Record<string, ConversationMessage[]>;
    conversationStoppingCriterion: Record<string, { agentId: string; reason: string; confidence: number } | null>;
    activeTopicId: string | null;
    agentRoster: AgentRosterCard[];
}>) {
    useWarRoomStore.setState(state as any);
}

// Stub the mount-time fetch from /api/v1/state so component renders in
// isolation. Each test installs the mock; restoreAllMocks() runs after.
function stubFetchOk(body: any = {}) {
    const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(''),
    });
    // @ts-expect-error happy-dom global
    global.fetch = fetchMock;
    return fetchMock;
}

describe('ConversationTheater', () => {
    it('shows the idle "no threads" sidebar + idle stage when there are no topics', async () => {
        stubFetchOk({ conversations: [] });
        render(<ConversationTheater />);

        expect(screen.getByText(/No previous threads found/i)).toBeTruthy();
        expect(screen.getByText(/ROUND-TABLE THEATER DEBATES/i)).toBeTruthy();
        // 0 THREADS chip in the sidebar header
        expect(screen.getByText(/0 THREADS/)).toBeTruthy();
    });

    it('lists every topic in the sidebar with its CHAIRS count and live beacon dot', () => {
        stubFetchOk();
        seed({
            topics: [
                makeTopic({ id: 't1', title: 'retry policy', participants: ['nyx-antigravity', 'shaev'], active: true }),
                makeTopic({ id: 't2', title: 'committee onboarding', participants: ['nyx-codex'], active: false }),
            ],
            agentRoster: [makeCard('nyx-antigravity'), makeCard('shaev'), makeCard('nyx-codex')],
        });
        render(<ConversationTheater />);

        expect(screen.getByText('retry policy')).toBeTruthy();
        expect(screen.getByText('committee onboarding')).toBeTruthy();
        // Singular vs plural correctness on the CHAIRS counter
        expect(screen.getByText(/2 CHAIRS/)).toBeTruthy();
        expect(screen.getByText(/1 CHAIR$/)).toBeTruthy();
        expect(screen.getByText(/2 THREADS/)).toBeTruthy();
    });

    it('renders the main stage when a topic is active and selected', () => {
        stubFetchOk();
        seed({
            topics: [makeTopic({ id: 't1', title: 'retry policy', active: true })],
            messagesByTopic: { t1: [makeMessage({ topicId: 't1', senderId: 'nyx-antigravity', content: 'mesh state nominal' })] },
            activeTopicId: 't1',
            agentRoster: [makeCard('nyx-antigravity', { name: 'Nyx-Antigravity' })],
        });
        render(<ConversationTheater />);

        // The header for the active debate is visible
        expect(screen.getByText(/ACTIVE DEBATE THREAD/i)).toBeTruthy();
        // The STREAMING DELTAS badge appears because topic.active = true
        expect(screen.getByText(/STREAMING DELTAS/i)).toBeTruthy();
        // The Stage swaps to CONVENING (active speaker derived from last assistant message)
        expect(screen.getByText(/CONVENING/i)).toBeTruthy();
        // The MessageList shows the message body
        expect(screen.getByText(/mesh state nominal/i)).toBeTruthy();
    });

    it('renders the StoppingCard when a stopping criterion exists for the active topic', () => {
        stubFetchOk();
        seed({
            topics: [makeTopic({ id: 't1', active: true })],
            messagesByTopic: { t1: [] },
            conversationStoppingCriterion: {
                t1: { agentId: 'shaev', reason: 'adaptive_stability_reached:delta=0.04<0.05', confidence: 0.87 },
            },
            activeTopicId: 't1',
            agentRoster: [makeCard('shaev')],
        });
        render(<ConversationTheater />);

        expect(screen.getByText(/VERIFIER CONSENSUS REACHED/i)).toBeTruthy();
        expect(screen.getByText(/CONFIDENCE:\s*87%/)).toBeTruthy();
    });

    it('clicking a sidebar topic calls selectTopic and updates the active view', () => {
        stubFetchOk();
        const selectTopic = vi.fn();
        seed({
            topics: [
                makeTopic({ id: 't1', title: 'first', active: false }),
                makeTopic({ id: 't2', title: 'second', active: false }),
            ],
            agentRoster: [],
        });
        // Override the store action with our spy
        useWarRoomStore.setState({ selectTopic } as any);

        render(<ConversationTheater />);
        fireEvent.click(screen.getByText('second'));
        expect(selectTopic).toHaveBeenCalledWith('t2');
    });

    it('HALT button on an active topic POSTs the close endpoint', async () => {
        const fetchMock = stubFetchOk();
        seed({
            topics: [makeTopic({ id: 't1', title: 'closeable', active: true })],
            agentRoster: [],
        });
        render(<ConversationTheater />);
        // Drain the initial state-prefetch call
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        fetchMock.mockClear();

        const halt = screen.getByRole('button', { name: /^HALT$/i });
        fireEvent.click(halt);

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/api/v1/conversations/t1/close');
        expect(init.method).toBe('POST');
    });

    it('does not crash if the mount-time state prefetch fails (offline orchestrator)', () => {
        // @ts-expect-error happy-dom global
        global.fetch = vi.fn().mockRejectedValue(new Error('connection refused'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(() => render(<ConversationTheater />)).not.toThrow();
        warn.mockRestore();
    });

    it('does not derive an active speaker when the last message is from the operator', () => {
        stubFetchOk();
        seed({
            topics: [makeTopic({ id: 't1', active: true })],
            messagesByTopic: {
                t1: [
                    makeMessage({ topicId: 't1', senderId: 'shaev', role: 'assistant', content: 'ack' }),
                    makeMessage({ topicId: 't1', senderId: 'operator', role: 'user', content: 'go again' }),
                ],
            },
            activeTopicId: 't1',
            agentRoster: [makeCard('shaev')],
        });
        render(<ConversationTheater />);
        // Last message is user → no active speaker → Stage shows STANDBY, not CONVENING
        expect(screen.queryByText(/CONVENING/i)).toBeNull();
        expect(screen.getByText(/STANDBY/i)).toBeTruthy();
    });

    it('does not show STREAMING DELTAS for a closed (inactive) topic', () => {
        stubFetchOk();
        seed({
            topics: [makeTopic({ id: 't1', title: 'done', active: false })],
            messagesByTopic: { t1: [makeMessage({ topicId: 't1' })] },
            activeTopicId: 't1',
            agentRoster: [makeCard('nyx-antigravity')],
        });
        render(<ConversationTheater />);
        expect(screen.queryByText(/STREAMING DELTAS/i)).toBeNull();
    });

    it('rejects a HALT click after the topic has been closed (no HALT button)', () => {
        stubFetchOk();
        seed({
            topics: [makeTopic({ id: 't1', active: false })],
            agentRoster: [],
        });
        render(<ConversationTheater />);
        expect(screen.queryByRole('button', { name: /^HALT$/i })).toBeNull();
    });
});
