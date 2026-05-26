import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChairRegistry } from '../services/ChairRegistry.js';
import {
    ChairBridgeDispatchFailure,
    ChairBridgeProvider,
    type ChairDispatchTelemetryEvent,
    type ChairReplySubmission,
} from '../services/ModelProvider.js';
import { createChairReplyProof } from '../services/ChairDispatchSecurity.js';

describe('ChairBridgeProvider request receipts', () => {
    let chairs: ChairRegistry;
    const originalFetch = global.fetch;
    const originalReplyTimeout = process.env.KOVAEL_CHAIR_REPLY_TIMEOUT_MS;

    beforeEach(() => {
        chairs = new ChairRegistry();
        chairs.start();
        chairs.claim({
            agentId: 'shaev',
            provider: 'vitest',
            inboxUrl: 'http://127.0.0.1:9999/inbox',
        });
    });

    afterEach(() => {
        global.fetch = originalFetch;
        vi.useRealTimers();
        if (originalReplyTimeout === undefined) {
            delete process.env.KOVAEL_CHAIR_REPLY_TIMEOUT_MS;
        } else {
            process.env.KOVAEL_CHAIR_REPLY_TIMEOUT_MS = originalReplyTimeout;
        }
        chairs.stop();
    });

    async function consume(stream: AsyncIterable<{ delta: string }>): Promise<string> {
        const deltas: string[] = [];
        for await (const chunk of stream) {
            deltas.push(chunk.delta);
        }
        return deltas.join('');
    }

    it('routes concurrent same-topic same-agent replies by requestId', async () => {
        const dispatches: Array<Record<string, string>> = [];
        global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            dispatches.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, string>);
            return new Response('', { status: 200 });
        }) as typeof fetch;

        const provider = new ChairBridgeProvider('shaev', chairs, 8080, {
            dispatchTimeoutMs: 1_000,
            maxAttempts: 1,
            baseBackoffMs: 1,
        });
        const first = consume(provider.stream({
            system: '',
            messages: [{ role: 'user', content: 'first' }],
            topicId: 'topic-shared',
            agentId: 'shaev',
        }));
        const second = consume(provider.stream({
            system: '',
            messages: [{ role: 'user', content: 'second' }],
            topicId: 'topic-shared',
            agentId: 'shaev',
        }));

        await waitFor(() => dispatches.length === 2);
        const [firstDispatch, secondDispatch] = dispatches;
        expect(firstDispatch.requestId).not.toBe(secondDispatch.requestId);

        submitSecuredReply(secondDispatch, 'second-result');
        submitSecuredReply(firstDispatch, 'first-result');

        await expect(first).resolves.toBe('first-result');
        await expect(second).resolves.toBe('second-result');
    });

    it('accepts a request-bound reply after the agent reclaims the chair', async () => {
        let dispatch: Record<string, string> | undefined;
        global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            dispatch = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
            return new Response('', { status: 200 });
        }) as typeof fetch;

        const provider = new ChairBridgeProvider('shaev', chairs, 8080, {
            dispatchTimeoutMs: 1_000,
            maxAttempts: 1,
            baseBackoffMs: 1,
        });
        const reply = consume(provider.stream({
            system: '',
            messages: [{ role: 'user', content: 'reply after reclaim' }],
            topicId: 'topic-reclaim',
            agentId: 'shaev',
        }));

        await waitFor(() => dispatch !== undefined);
        chairs.claim({
            agentId: 'shaev',
            provider: 'vitest',
            inboxUrl: 'http://127.0.0.1:9999/reclaimed-inbox',
        });

        const result = submitSecuredReply(dispatch!, 'accepted after reclaim', 'succeeded', chairs.get('shaev')?.sessionId);
        expect(result).toMatchObject({ ok: true });
        await expect(reply).resolves.toBe('accepted after reclaim');
    });

    it('rejects wrong claim sessions and invalid proof replies', async () => {
        const dispatches: Array<Record<string, string>> = [];
        global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            dispatches.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, string>);
            return new Response('', { status: 200 });
        }) as typeof fetch;

        const provider = new ChairBridgeProvider('shaev', chairs, 8080, {
            dispatchTimeoutMs: 1_000,
            maxAttempts: 1,
            baseBackoffMs: 1,
        });
        const reply = consume(provider.stream({
            system: '',
            messages: [{ role: 'user', content: 'secure reply' }],
            topicId: 'topic-secure',
            agentId: 'shaev',
        }));

        await waitFor(() => dispatches.length === 1);
        const dispatch = dispatches[0];
        const wrongTarget = ChairBridgeProvider.submitReplyForRequest({
            requestId: dispatch.requestId,
            agentId: 'other-agent',
            topicId: dispatch.topicId,
            claimSessionId: dispatch.claimSessionId,
            replyProof: createChairReplyProof({
                requestId: dispatch.requestId,
                claimSessionId: dispatch.claimSessionId,
                replyProofSecret: dispatch.replyProofSecret,
            }),
            content: 'misdirected',
        });
        expect(wrongTarget).toMatchObject({ ok: false, status: 409, code: 'wrong_chair_dispatch_target' });

        const badProof = ChairBridgeProvider.submitReplyForRequest({
            requestId: dispatch.requestId,
            agentId: dispatch.agentId,
            topicId: dispatch.topicId,
            claimSessionId: dispatch.claimSessionId,
            replyProof: 'not-the-proof',
            content: 'spoofed',
        }, chairs.get('shaev')?.sessionId);
        expect(badProof).toMatchObject({ ok: false, status: 401, code: 'invalid_reply_proof' });

        const wrongClaim = ChairBridgeProvider.submitReplyForRequest({
            requestId: dispatch.requestId,
            agentId: dispatch.agentId,
            topicId: dispatch.topicId,
            claimSessionId: 'stale-session',
            replyProof: createChairReplyProof({
                requestId: dispatch.requestId,
                claimSessionId: 'stale-session',
                replyProofSecret: dispatch.replyProofSecret,
            }),
            content: 'stale',
        }, chairs.get('shaev')?.sessionId);
        expect(wrongClaim).toMatchObject({ ok: false, status: 409, code: 'wrong_claim_session' });

        submitSecuredReply(dispatch, 'accepted');
        await expect(reply).resolves.toBe('accepted');
    });

    it('times out replies only after dispatch POST succeeds', async () => {
        vi.useFakeTimers();
        let dispatch: Record<string, string> | undefined;
        let acceptPost: (() => void) | undefined;
        const postAccepted = new Promise<void>((resolve) => {
            acceptPost = resolve;
        });
        global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            dispatch = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
            await postAccepted;
            return new Response('', { status: 200 });
        }) as typeof fetch;
        process.env.KOVAEL_CHAIR_REPLY_TIMEOUT_MS = '5000';

        const provider = new ChairBridgeProvider('shaev', chairs, 8080, {
            dispatchTimeoutMs: 10_000,
            maxAttempts: 1,
            baseBackoffMs: 1,
        });
        const reply = consume(provider.stream({
            system: '',
            messages: [{ role: 'user', content: 'timeout after post' }],
            topicId: 'topic-timeout',
            agentId: 'shaev',
        }));

        await vi.waitFor(() => expect(dispatch).toBeDefined());
        await vi.advanceTimersByTimeAsync(5_000);
        expect(ChairBridgeProvider.submitReplyForRequest({
            requestId: dispatch!.requestId,
            agentId: dispatch!.agentId,
            topicId: dispatch!.topicId,
            claimSessionId: dispatch!.claimSessionId,
            replyProof: createChairReplyProof({
                requestId: dispatch!.requestId,
                claimSessionId: dispatch!.claimSessionId,
                replyProofSecret: dispatch!.replyProofSecret,
            }),
            content: 'still pending before post accepted',
        })).toMatchObject({ ok: true });
        acceptPost!();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(500);

        await expect(reply).resolves.toBe('still pending before post accepted');
        vi.useRealTimers();
        delete process.env.KOVAEL_CHAIR_REPLY_TIMEOUT_MS;
    });

    it('cleans up pending reply when caller aborts after POST acceptance', async () => {
        let dispatch: Record<string, string> | undefined;
        global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            dispatch = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
            return new Response('', { status: 200 });
        }) as typeof fetch;

        const ctrl = new AbortController();
        const provider = new ChairBridgeProvider('shaev', chairs, 8080, {
            dispatchTimeoutMs: 1_000,
            maxAttempts: 1,
            baseBackoffMs: 1,
        });
        const reply = consume(provider.stream({
            system: '',
            messages: [{ role: 'user', content: 'abort after post' }],
            topicId: 'topic-abort',
            agentId: 'shaev',
            signal: ctrl.signal,
        }));

        await waitFor(() => dispatch !== undefined);
        await new Promise((resolve) => setTimeout(resolve, 0));
        ctrl.abort();
        let abortError: unknown;
        try {
            await reply;
        } catch (err) {
            abortError = err;
        }
        expect(abortError).toBeInstanceOf(ChairBridgeDispatchFailure);
        expect(abortError).toMatchObject({
            details: {
                requestId: dispatch!.requestId,
                agentId: 'shaev',
                claimSessionId: dispatch!.claimSessionId,
                dispatchAttempts: 1,
                dispatchLatencyMs: expect.any(Number),
            },
        });

        const late = ChairBridgeProvider.submitReplyForRequest({
            requestId: dispatch!.requestId,
            agentId: dispatch!.agentId,
            topicId: dispatch!.topicId,
            claimSessionId: dispatch!.claimSessionId,
            replyProof: createChairReplyProof({
                requestId: dispatch!.requestId,
                claimSessionId: dispatch!.claimSessionId,
                replyProofSecret: dispatch!.replyProofSecret,
            }),
            content: 'too late',
        });
        expect(late).toMatchObject({ ok: false, status: 404, code: 'unknown_chair_dispatch_request' });
    });

    it('carries request-bound metadata on post-accept reply timeout', async () => {
        vi.useFakeTimers();
        process.env.KOVAEL_CHAIR_REPLY_TIMEOUT_MS = '5000';
        let dispatch: Record<string, string> | undefined;
        global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            dispatch = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
            return new Response('', { status: 200 });
        }) as typeof fetch;

        const provider = new ChairBridgeProvider('shaev', chairs, 8080, {
            dispatchTimeoutMs: 1_000,
            maxAttempts: 1,
            baseBackoffMs: 1,
        });
        const reply = consume(provider.stream({
            system: '',
            messages: [{ role: 'user', content: 'timeout metadata' }],
            topicId: 'topic-timeout-metadata',
            agentId: 'shaev',
        }));
        const timeoutResult = reply
            .then(() => undefined)
            .catch((err: unknown) => err);

        await vi.waitFor(() => expect(dispatch).toBeDefined());
        await vi.advanceTimersByTimeAsync(5_000);

        const timeoutError = await timeoutResult;
        expect(timeoutError).toBeInstanceOf(ChairBridgeDispatchFailure);
        expect(timeoutError).toMatchObject({
            details: {
                requestId: dispatch!.requestId,
                agentId: 'shaev',
                claimSessionId: dispatch!.claimSessionId,
                dispatchAttempts: 1,
                dispatchLatencyMs: expect.any(Number),
            },
        });
    });

    it('records dispatch retry attempt count on the accepted reply receipt', async () => {
        let attempts = 0;
        let dispatch: Record<string, string> | undefined;
        global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            attempts += 1;
            dispatch = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
            return new Response('', { status: attempts === 1 ? 503 : 200 });
        }) as typeof fetch;

        const provider = new ChairBridgeProvider('shaev', chairs, 8080, {
            dispatchTimeoutMs: 1_000,
            maxAttempts: 2,
            baseBackoffMs: 1,
        });
        const reply = consume(provider.stream({
            system: '',
            messages: [{ role: 'user', content: 'retry telemetry' }],
            topicId: 'topic-retry',
            agentId: 'shaev',
        }));

        await waitFor(() => attempts === 2 && dispatch !== undefined);
        submitSecuredReply(dispatch!, 'retried');

        await expect(reply).resolves.toBe('retried');
        expect(provider.getLastReceipt()).toMatchObject({ dispatchAttempts: 2 });
    });

    it('records attempt and latency when the chair replies before dispatch POST returns', async () => {
        let dispatch: Record<string, string> | undefined;
        global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            dispatch = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
            submitSecuredReply(dispatch, 'fast reply');
            return new Response('', { status: 200 });
        }) as typeof fetch;

        const provider = new ChairBridgeProvider('shaev', chairs, 8080, {
            dispatchTimeoutMs: 1_000,
            maxAttempts: 1,
            baseBackoffMs: 1,
        });

        await expect(consume(provider.stream({
            system: '',
            messages: [{ role: 'user', content: 'fast reply' }],
            topicId: 'topic-fast-reply',
            agentId: 'shaev',
        }))).resolves.toBe('fast reply');

        expect(provider.getLastReceipt()).toMatchObject({
            requestId: dispatch!.requestId,
            dispatchAttempts: 1,
            dispatchLatencyMs: expect.any(Number),
        });
    });

    it('does not let telemetry observer failures break a valid dispatch', async () => {
        let dispatch: Record<string, string> | undefined;
        global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            dispatch = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
            return new Response('', { status: 200 });
        }) as typeof fetch;

        const provider = new ChairBridgeProvider('shaev', chairs, 8080, {
            dispatchTimeoutMs: 1_000,
            maxAttempts: 1,
            baseBackoffMs: 1,
            onDispatchEvent: () => {
                throw new Error('observer failed');
            },
        });
        const reply = consume(provider.stream({
            system: '',
            messages: [{ role: 'user', content: 'observer failure should not matter' }],
            topicId: 'topic-observer-fail',
            agentId: 'shaev',
        }));

        await waitFor(() => dispatch !== undefined);
        submitSecuredReply(dispatch!, 'observer-safe');

        await expect(reply).resolves.toBe('observer-safe');
    });

    it('emits sanitized request-bound dispatch started and attempt telemetry', async () => {
        const events: ChairDispatchTelemetryEvent[] = [];
        let attempts = 0;
        let dispatch: Record<string, string> | undefined;
        global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            attempts += 1;
            dispatch = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
            return new Response('', { status: attempts === 1 ? 503 : 200 });
        }) as typeof fetch;

        const provider = new ChairBridgeProvider('shaev', chairs, 8080, {
            dispatchTimeoutMs: 1_000,
            maxAttempts: 2,
            baseBackoffMs: 1,
            onDispatchEvent: (event) => events.push(event),
        });
        const reply = consume(provider.stream({
            system: 'system prompt must not leak',
            messages: [{ role: 'user', content: 'raw user text must not leak' }],
            topicId: 'topic-telemetry',
            agentId: 'shaev',
        }));

        await waitFor(() => attempts === 2 && dispatch !== undefined);
        submitSecuredReply(dispatch!, 'telemetry ok');
        await expect(reply).resolves.toBe('telemetry ok');

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'chair_dispatch_started',
                requestId: dispatch!.requestId,
                agentId: 'shaev',
                claimSessionId: dispatch!.claimSessionId,
                attempt: 0,
            }),
            expect.objectContaining({
                type: 'chair_dispatch_attempt',
                requestId: dispatch!.requestId,
                agentId: 'shaev',
                claimSessionId: dispatch!.claimSessionId,
                attempt: 1,
                dispatchLatencyMs: expect.any(Number),
            }),
            expect.objectContaining({
                type: 'chair_dispatch_attempt',
                requestId: dispatch!.requestId,
                agentId: 'shaev',
                claimSessionId: dispatch!.claimSessionId,
                attempt: 2,
                dispatchLatencyMs: expect.any(Number),
            }),
        ]));
        const serialized = JSON.stringify(events);
        expect(serialized).not.toContain('system prompt must not leak');
        expect(serialized).not.toContain('raw user text must not leak');
        expect(serialized).not.toContain(dispatch!.replyProofSecret);
        expect(serialized).not.toContain('/inbox');
        expect(serialized).not.toContain('authorization');
    });

    it('treats runtime failure replies as dispatch failures', async () => {
        let dispatch: Record<string, string> | undefined;
        global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            dispatch = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
            return new Response('', { status: 200 });
        }) as typeof fetch;

        const provider = new ChairBridgeProvider('shaev', chairs, 8080, {
            dispatchTimeoutMs: 1_000,
            maxAttempts: 1,
            baseBackoffMs: 1,
        });
        const reply = consume(provider.stream({
            system: '',
            messages: [{ role: 'user', content: 'fail honestly' }],
            topicId: 'topic-fail',
            agentId: 'shaev',
        }));

        await waitFor(() => dispatch !== undefined);
        submitSecuredReply(dispatch!, 'Runtime error from shaev: missing cli', 'failed');

        await expect(reply).rejects.toThrow(/missing cli/);
    });
});

function submitSecuredReply(
    dispatch: Record<string, string>,
    content: string,
    status: ChairReplySubmission['status'] = 'succeeded',
    activeClaimSessionId?: string,
) {
    const result = ChairBridgeProvider.submitReplyForRequest({
        requestId: dispatch.requestId,
        agentId: dispatch.agentId,
        topicId: dispatch.topicId,
        claimSessionId: dispatch.claimSessionId,
        replyProof: createChairReplyProof({
            requestId: dispatch.requestId,
            claimSessionId: dispatch.claimSessionId,
            replyProofSecret: dispatch.replyProofSecret,
        }),
        content,
        status,
        error: status === 'failed' ? content : undefined,
    }, activeClaimSessionId);
    expect(result).toMatchObject({ ok: true });
    return result;
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for predicate');
}
