import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChairRegistry } from '../services/ChairRegistry.js';
import {
    ChairBridgeProvider,
    type ChairReplySubmission,
} from '../services/ModelProvider.js';
import { createChairReplyProof } from '../services/ChairDispatchSecurity.js';

describe('ChairBridgeProvider request receipts', () => {
    let chairs: ChairRegistry;
    const originalFetch = global.fetch;

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

    it('rejects stale sessions and invalid proof replies', async () => {
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
        const badProof = ChairBridgeProvider.submitReplyForRequest({
            requestId: dispatch.requestId,
            agentId: dispatch.agentId,
            topicId: dispatch.topicId,
            claimSessionId: dispatch.claimSessionId,
            replyProof: 'not-the-proof',
            content: 'spoofed',
        }, chairs.get('shaev')?.sessionId);
        expect(badProof).toMatchObject({ ok: false, status: 401, code: 'invalid_reply_proof' });

        const stale = ChairBridgeProvider.submitReplyForRequest({
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
        expect(stale).toMatchObject({ ok: false, status: 409, code: 'wrong_claim_session' });

        submitSecuredReply(dispatch, 'accepted');
        await expect(reply).resolves.toBe('accepted');
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
): void {
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
    });
    expect(result).toMatchObject({ ok: true });
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for predicate');
}
