// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConvenePanel } from '../../src/components/theater/ConvenePanel';
import type { AgentRosterCard } from '../../src/store/useWarRoomStore';

function card(id: string, overrides: Partial<AgentRosterCard> = {}): AgentRosterCard {
    return {
        id,
        name: id,
        provider: 'Test · Provider',
        status: 'online',
        ...overrides,
    };
}

function liveChair(sessionId: string): NonNullable<AgentRosterCard['chair']> {
    return {
        sessionId,
        claimedAt: Date.now() - 1_000,
        lastBeaconAt: Date.now() - 500,
        presence: 'live',
        inboxUrl: `http://localhost:9999/${sessionId}/inbox`,
    };
}

function presenceOnlyChair(sessionId: string): NonNullable<AgentRosterCard['chair']> {
    const { inboxUrl: _inboxUrl, ...chair } = liveChair(sessionId);
    void _inboxUrl;
    return chair;
}

const ROSTER: AgentRosterCard[] = [
    card('nyx-antigravity', { name: 'Nyx-Antigravity', accent_hex: '#d97706' }),
    card('shaev',           { name: 'Shaev', accent_hex: '#059669', chair: liveChair('shaev-session') }),
    card('nyx-codex',       { name: 'Nyx-Codex', accent_hex: '#7c3aed', chair: liveChair('codex-session') }),
    card('offline-chair',   { status: 'offline' }), // should be filtered out
];

describe('ConvenePanel', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        // Use vi.stubGlobal so vi.unstubAllGlobals() in afterEach actually
        // restores the original fetch reference — `global.fetch = ...`
        // reassignment leaks past `vi.restoreAllMocks()` (which only resets
        // tracked mock fns, not arbitrary global reassignments).
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('renders the title + goal inputs and the dispatch button', () => {
        render(<ConvenePanel roster={ROSTER} />);
        expect(screen.getByLabelText(/TOPIC TITLE/i)).toBeTruthy();
        expect(screen.getByLabelText(/CONVENE INSTRUCTION/i)).toBeTruthy();
        expect(screen.getByRole('button', { name: /DISPATCH CONVENER/i })).toBeTruthy();
    });

    it('shows only live claimed chairs in the participant grid', () => {
        const { container } = render(<ConvenePanel roster={ROSTER} />);
        // Each chair button is a <button type="button"> inside the grid;
        // offline and unclaimed static chairs must be excluded so they cannot
        // be selected by accident.
        const chairButtons = container.querySelectorAll('button[type="button"]');
        const ids = Array.from(chairButtons).map((b) => b.textContent ?? '');
        expect(ids.some((t) => t.toLowerCase().includes('nyx-antigravity'))).toBe(false);
        expect(ids.some((t) => t.toLowerCase().includes('offline-chair'))).toBe(false);
        expect(chairButtons.length).toBe(2);
    });

    it('derives the topic title from the goal if title is empty', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ id: 'topic-derived-title' }),
            text: () => Promise.resolve(''),
        });
        render(<ConvenePanel roster={ROSTER} />);
        fireEvent.change(screen.getByLabelText(/CONVENE INSTRUCTION/i), { target: { value: 'Converge on the lightest working dispatch path.' } });
        fireEvent.click(screen.getByRole('button', { name: /shaev/i }));
        fireEvent.click(screen.getByRole('button', { name: /DISPATCH CONVENER/i }));

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const [, init] = fetchMock.mock.calls[0];
        const body = JSON.parse(init.body);
        expect(body.title).toBe('Converge on the lightest working dispatch path.');
        expect(body.goal).toBe('Converge on the lightest working dispatch path.');
    });

    it('shows an error if no participants are selected even with title + goal filled', async () => {
        render(<ConvenePanel roster={ROSTER} />);
        fireEvent.change(screen.getByLabelText(/TOPIC TITLE/i), { target: { value: 'A topic' } });
        fireEvent.change(screen.getByLabelText(/CONVENE INSTRUCTION/i), { target: { value: 'a goal' } });
        fireEvent.click(screen.getByRole('button', { name: /DISPATCH CONVENER/i }));
        await waitFor(() => expect(screen.getByText(/select at least one agent/i)).toBeTruthy());
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('POSTs to /api/v1/conversations with the title + participants when form is valid', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ topic: { id: 'topic-xyz-123' } }),
            text: () => Promise.resolve(''),
        });

        const onTopicCreated = vi.fn();
        render(<ConvenePanel roster={ROSTER} onTopicCreated={onTopicCreated} />);

        fireEvent.change(screen.getByLabelText(/TOPIC TITLE/i), { target: { value: 'design retry policy' } });
        fireEvent.change(screen.getByLabelText(/CONVENE INSTRUCTION/i), { target: { value: 'converge on a plan' } });
        // Pick two chairs
        const chairButtons = screen.getAllByRole('button').filter((b) => b.getAttribute('type') === 'button');
        fireEvent.click(chairButtons[0]);
        fireEvent.click(chairButtons[1]);

        fireEvent.click(screen.getByRole('button', { name: /DISPATCH CONVENER/i }));

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/api/v1/conversations');
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body);
        expect(body.title).toBe('design retry policy');
        expect(body.goal).toBe('converge on a plan');
        expect(Array.isArray(body.participants)).toBe(true);
        expect(body.participants.length).toBe(2);

        await waitFor(() => expect(onTopicCreated).toHaveBeenCalledWith('topic-xyz-123'));
    });

    it('selects the created topic when the API returns the direct topic contract', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({
                id: 'topic-direct-123',
                title: 'direct topic',
                participants: ['shaev'],
                active: true,
            }),
            text: () => Promise.resolve(''),
        });

        const onTopicCreated = vi.fn();
        render(<ConvenePanel roster={ROSTER} onTopicCreated={onTopicCreated} />);

        fireEvent.change(screen.getByLabelText(/TOPIC TITLE/i), { target: { value: 'direct topic' } });
        fireEvent.change(screen.getByLabelText(/CONVENE INSTRUCTION/i), { target: { value: 'reply once' } });
        const chairButtons = screen.getAllByRole('button').filter((b) => b.getAttribute('type') === 'button');
        fireEvent.click(chairButtons[0]);

        fireEvent.click(screen.getByRole('button', { name: /DISPATCH CONVENER/i }));

        await waitFor(() => expect(onTopicCreated).toHaveBeenCalledWith('topic-direct-123'));
    });

    it('caps participant selection at 9 (selecting a 10th has no effect)', () => {
        const overfull = Array.from({ length: 12 }, (_, i) => card(`agent-${i}`, { chair: liveChair(`agent-${i}-session`) }));
        render(<ConvenePanel roster={overfull} />);
        const chairButtons = screen.getAllByRole('button').filter((b) => b.getAttribute('type') === 'button');

        for (const b of chairButtons.slice(0, 12)) fireEvent.click(b);
        // The chip header echoes the count: "SELECT PARTICIPATING CHAIRS (N SELECTED)"
        expect(screen.getByText(/\(9 SELECTED\)/)).toBeTruthy();
    });

    it('clicking a selected chair a second time deselects it', () => {
        render(<ConvenePanel roster={ROSTER} />);
        const chairButtons = screen.getAllByRole('button').filter((b) => b.getAttribute('type') === 'button');
        const target = chairButtons[0];
        fireEvent.click(target);
        expect(screen.getByText(/\(1 SELECTED\)/)).toBeTruthy();
        expect(target.getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(target);
        expect(screen.getByText(/\(0 SELECTED\)/)).toBeTruthy();
        expect(target.getAttribute('aria-pressed')).toBe('false');
    });

    it('surfaces a server error message when the POST returns non-OK', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 500,
            text: () => Promise.resolve('orchestrator unavailable'),
            json: () => Promise.resolve({}),
        });
        render(<ConvenePanel roster={ROSTER} />);
        fireEvent.change(screen.getByLabelText(/TOPIC TITLE/i), { target: { value: 'x' } });
        fireEvent.change(screen.getByLabelText(/CONVENE INSTRUCTION/i), { target: { value: 'y' } });
        const chairButtons = screen.getAllByRole('button').filter((b) => b.getAttribute('type') === 'button');
        fireEvent.click(chairButtons[0]);
        fireEvent.click(screen.getByRole('button', { name: /DISPATCH CONVENER/i }));
        await waitFor(() => expect(screen.getByText(/orchestrator unavailable/i)).toBeTruthy());
    });

    it('disables the dispatch button when there are no live claimed chairs', () => {
        render(<ConvenePanel roster={[card('unclaimed-online'), card('offline-only', { status: 'offline' })]} />);
        const submit = screen.getByRole('button', { name: /DISPATCH CONVENER/i });
        expect((submit as HTMLButtonElement).disabled).toBe(true);
    });

    it('offers presence-only live chairs for transparent backend handling', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ id: 'topic-presence-only' }),
            text: () => Promise.resolve(''),
        });
        render(<ConvenePanel roster={[card('presence-only', { chair: presenceOnlyChair('presence-session') })]} />);

        fireEvent.change(screen.getByLabelText(/TOPIC TITLE/i), { target: { value: 'presence check' } });
        fireEvent.change(screen.getByLabelText(/CONVENE INSTRUCTION/i), { target: { value: 'reply if reachable' } });
        fireEvent.click(screen.getByRole('button', { name: /presence-only/i }));
        fireEvent.click(screen.getByRole('button', { name: /DISPATCH CONVENER/i }));

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const [, init] = fetchMock.mock.calls[0];
        const body = JSON.parse(init.body);
        expect(body.participants).toEqual(['presence-only']);
    });

    it('keeps selected live chairs when they lose their dispatch inbox before submit', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ id: 'topic-presence-fallback' }),
            text: () => Promise.resolve(''),
        });
        const { rerender } = render(<ConvenePanel roster={ROSTER} />);

        fireEvent.change(screen.getByLabelText(/TOPIC TITLE/i), { target: { value: 'stale selection' } });
        fireEvent.change(screen.getByLabelText(/CONVENE INSTRUCTION/i), { target: { value: 'reply if reachable' } });
        fireEvent.click(screen.getByRole('button', { name: /shaev/i }));
        expect(screen.getByText(/\(1 SELECTED\)/)).toBeTruthy();

        rerender(
            <ConvenePanel
                roster={[
                    card('shaev', { name: 'Shaev', accent_hex: '#059669', chair: presenceOnlyChair('shaev-session') }),
                    card('nyx-codex', { name: 'Nyx-Codex', accent_hex: '#7c3aed', chair: liveChair('codex-session') }),
                ]}
            />,
        );

        expect(screen.getByText(/\(1 SELECTED\)/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /DISPATCH CONVENER/i }));

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const [, init] = fetchMock.mock.calls[0];
        const body = JSON.parse(init.body);
        expect(body.participants).toEqual(['shaev']);
    });
});
