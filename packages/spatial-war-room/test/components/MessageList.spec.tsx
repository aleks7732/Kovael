// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MessageList } from '../../src/components/theater/MessageList';
import type { AgentRosterCard, ConversationMessage } from '../../src/store/useWarRoomStore';

// happy-dom omits a couple of layout APIs that the component touches in
// effects — stub them so the auto-scroll effect doesn't throw.
beforeAll(() => {
    if (typeof window !== 'undefined') {
        Element.prototype.scrollIntoView = vi.fn();
    }
});

afterEach(() => cleanup());

function card(id: string, overrides: Partial<AgentRosterCard> = {}): AgentRosterCard {
    return {
        id,
        name: id,
        provider: 'test',
        status: 'online',
        ...overrides,
    };
}
function msg(overrides: Partial<ConversationMessage>): ConversationMessage {
    return {
        id: 'm-' + Math.random().toString(36).slice(2, 8),
        topicId: 't1',
        senderId: 'nyx-antigravity',
        role: 'assistant',
        content: 'hello',
        timestamp: Date.UTC(2026, 4, 20, 7, 30, 0),
        ...overrides,
    };
}

const ROSTER: AgentRosterCard[] = [
    card('nyx-antigravity', { name: 'Nyx-Antigravity', accent_hex: '#d97706', portrait_url: '/agents/nyx-antigravity.png' }),
    card('shaev',           { name: 'Shaev (in Hermes)', accent_hex: '#059669' }),
    card('nyx-codex',       { name: 'Nyx-Codex', accent_hex: '#7c3aed' }),
];

describe('MessageList', () => {
    it('shows the placeholder when there is no active topic', () => {
        render(<MessageList messages={[]} roster={ROSTER} activeTopicId={null} activeSpeakerId={null} />);
        expect(screen.getByText(/No Active Conversation Thread/i)).toBeTruthy();
    });

    it('shows an "awaiting first reply" state when topic is open but transcript is empty', () => {
        render(<MessageList messages={[]} roster={ROSTER} activeTopicId="t1" activeSpeakerId={null} />);
        expect(screen.getByText(/Awaiting first participant reply/i)).toBeTruthy();
    });

    it('renders a message bubble with the sender display name (with nyx- prefix stripped)', () => {
        const m = msg({ senderId: 'nyx-antigravity', content: 'mesh state nominal' });
        render(<MessageList messages={[m]} roster={ROSTER} activeTopicId="t1" activeSpeakerId={null} />);
        // Display name in the bubble header has the nyx- prefix stripped
        expect(screen.getByText('Nyx-Antigravity')).toBeTruthy();
        expect(screen.getByText('mesh state nominal')).toBeTruthy();
    });

    it('renders a system message as a centred banner, not a bubble', () => {
        const m = msg({ role: 'system', content: 'topic opened', senderId: 'orchestrator' });
        render(<MessageList messages={[m]} roster={ROSTER} activeTopicId="t1" activeSpeakerId={null} />);
        expect(screen.getByText(/SYSTEM: topic opened/i)).toBeTruthy();
    });

    it('labels the operator turn as OPERATOR (YOU) regardless of senderId', () => {
        const m = msg({ role: 'user', senderId: 'operator', content: 'convene please' });
        render(<MessageList messages={[m]} roster={ROSTER} activeTopicId="t1" activeSpeakerId={null} />);
        expect(screen.getByText(/OPERATOR \(YOU\)/i)).toBeTruthy();
    });

    it('parses @mentions into interactive chips when the agent exists in the roster', () => {
        const m = msg({
            role: 'assistant',
            senderId: 'shaev',
            content: 'I will hand the rendering pass to @nyx-codex once VRAM frees.',
        });
        const { container } = render(<MessageList messages={[m]} roster={ROSTER} activeTopicId="t1" activeSpeakerId={null} />);
        const chip = container.querySelector('.bg-command-accent\\/15');
        expect(chip).not.toBeNull();
        expect(chip!.textContent).toBe('@nyx-codex');
    });

    it('does not turn an unknown @mention into a chip (no roster collision)', () => {
        const m = msg({ role: 'assistant', content: 'pinging @stranger-on-the-net but nobody home' });
        const { container } = render(<MessageList messages={[m]} roster={ROSTER} activeTopicId="t1" activeSpeakerId={null} />);
        expect(container.querySelectorAll('.bg-command-accent\\/15').length).toBe(0);
    });

    it('shows a streaming cursor on the last message when active speaker matches sender', () => {
        const last = msg({ senderId: 'shaev', content: 'rendering visual essence' });
        const { container } = render(
            <MessageList messages={[last]} roster={ROSTER} activeTopicId="t1" activeSpeakerId="shaev" />,
        );
        // The cursor is the inline animate-pulse span inside the bubble
        const cursor = container.querySelector('span.animate-pulse');
        expect(cursor).not.toBeNull();
    });

    it('counts messages in the header (singular vs plural)', () => {
        const single = render(
            <MessageList messages={[msg({})]} roster={ROSTER} activeTopicId="t1" activeSpeakerId={null} />,
        );
        expect(screen.getByText('1 MESSAGE')).toBeTruthy();
        single.unmount();
        cleanup();

        render(
            <MessageList messages={[msg({}), msg({})]} roster={ROSTER} activeTopicId="t1" activeSpeakerId={null} />,
        );
        expect(screen.getByText('2 MESSAGES')).toBeTruthy();
    });
});
