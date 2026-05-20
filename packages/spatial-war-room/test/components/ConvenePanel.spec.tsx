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

const ROSTER: AgentRosterCard[] = [
    card('nyx-antigravity', { name: 'Nyx-Antigravity', accent_hex: '#d97706' }),
    card('shaev',           { name: 'Shaev', accent_hex: '#059669' }),
    card('nyx-codex',       { name: 'Nyx-Codex', accent_hex: '#7c3aed' }),
    card('offline-chair',   { status: 'offline' }), // should be filtered out
];

describe('ConvenePanel', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        // vi.fn()'s loose signature doesn't structurally match the strict
        // global `fetch` overload; cast through unknown so the test config
        // type-check (tsconfig.test.json) stays happy without weakening
        // production code.
        global.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    it('renders the title + goal inputs and the dispatch button', () => {
        render(<ConvenePanel roster={ROSTER} />);
        expect(screen.getByLabelText(/TOPIC TITLE/i)).toBeTruthy();
        expect(screen.getByLabelText(/CONVENE INSTRUCTION/i)).toBeTruthy();
        expect(screen.getByRole('button', { name: /DISPATCH CONVENER/i })).toBeTruthy();
    });

    it('hides offline chairs from the participant grid', () => {
        const { container } = render(<ConvenePanel roster={ROSTER} />);
        // Each chair button is a <button type="button"> inside the grid;
        // offline chairs must be excluded so they cannot be selected.
        const chairButtons = container.querySelectorAll('button[type="button"]');
        const ids = Array.from(chairButtons).map((b) => b.textContent ?? '');
        expect(ids.some((t) => t.toLowerCase().includes('offline-chair'))).toBe(false);
        // Exactly 3 online chairs in our roster
        expect(chairButtons.length).toBe(3);
    });

    it('shows an error and does not POST if the form is submitted with no title', async () => {
        render(<ConvenePanel roster={ROSTER} />);
        const submit = screen.getByRole('button', { name: /DISPATCH CONVENER/i });
        fireEvent.click(submit);
        // Match the error text specifically (not the TOPIC TITLE label, which
        // also contains "topic title" case-insensitively).
        await waitFor(() =>
            expect(screen.getByText(/error: please provide a topic title/i)).toBeTruthy(),
        );
        expect(fetchMock).not.toHaveBeenCalled();
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

    it('caps participant selection at 9 (selecting a 10th has no effect)', () => {
        const overfull = Array.from({ length: 12 }, (_, i) => card(`agent-${i}`));
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
        fireEvent.click(target);
        expect(screen.getByText(/\(0 SELECTED\)/)).toBeTruthy();
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

    it('disables the dispatch button when there are no online chairs', () => {
        render(<ConvenePanel roster={[card('offline-only', { status: 'offline' })]} />);
        const submit = screen.getByRole('button', { name: /DISPATCH CONVENER/i });
        expect((submit as HTMLButtonElement).disabled).toBe(true);
    });
});
