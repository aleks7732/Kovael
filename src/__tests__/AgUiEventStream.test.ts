import { describe, it, expect } from 'vitest';
import { mapToAgUi, enrichWithAgUi } from '../services/AgUiEventStream.js';

describe('AgUiEventStream', () => {
    describe('mapToAgUi', () => {
        it('maps conversation_topic_opened to run.started', () => {
            const event = {
                type: 'conversation_topic_opened',
                topic: { id: 'topic-1', title: 'Design review', participants: ['nyx', 'shaev'] },
            };
            const agui = mapToAgUi(event);

            expect(agui).not.toBeNull();
            expect(agui!.type).toBe('run.started');
            expect(agui!.runId).toBe('topic-1');
            expect(agui!.data.title).toBe('Design review');
        });

        it('maps conversation_message_delta to message.delta', () => {
            const event = {
                type: 'conversation_message_delta',
                topicId: 'topic-1',
                messageId: 'msg-1',
                senderId: 'nyx',
                delta: 'Hello ',
                role: 'assistant',
                isEnd: false,
            };
            const agui = mapToAgUi(event);

            expect(agui!.type).toBe('message.delta');
            expect(agui!.data.delta).toBe('Hello ');
        });

        it('maps conversation_message_delta with isEnd to step.finished', () => {
            const event = {
                type: 'conversation_message_delta',
                topicId: 'topic-1',
                messageId: 'msg-1',
                senderId: 'nyx',
                role: 'assistant',
                isEnd: true,
                usage: { input: 100, output: 50 },
            };
            const agui = mapToAgUi(event);

            expect(agui!.type).toBe('step.finished');
            expect(agui!.data.usage).toEqual({ input: 100, output: 50 });
        });

        it('maps conversation_stopping_criterion to run.finished', () => {
            const event = {
                type: 'conversation_stopping_criterion',
                topicId: 'topic-1',
                reason: 'stability_reached',
                confidence: 0.95,
                agentId: 'nyx',
            };
            const agui = mapToAgUi(event);

            expect(agui!.type).toBe('run.finished');
            expect(agui!.data.reason).toBe('stability_reached');
        });

        it('maps conversation_topic_closed to run.finished', () => {
            const event = {
                type: 'conversation_topic_closed',
                topicId: 'topic-1',
            };
            const agui = mapToAgUi(event);

            expect(agui!.type).toBe('run.finished');
            expect(agui!.data.reason).toBe('topic_closed');
        });

        it('returns null for unknown event types', () => {
            expect(mapToAgUi({ type: 'hardware_telemetry' })).toBeNull();
            expect(mapToAgUi({ type: 'chair_beacon' })).toBeNull();
        });

        it('returns null for events without type', () => {
            expect(mapToAgUi({ data: 'hello' })).toBeNull();
        });
    });

    describe('enrichWithAgUi', () => {
        it('adds agui envelope for recognized events', () => {
            const event = {
                type: 'conversation_topic_opened',
                topic: { id: 't1', title: 'Test' },
            };
            const enriched = enrichWithAgUi(event);

            expect(enriched.type).toBe('conversation_topic_opened'); // original preserved
            expect(enriched.agui).toBeDefined();
            expect((enriched.agui as any).type).toBe('run.started');
        });

        it('passes through unrecognized events unchanged', () => {
            const event = { type: 'hardware_telemetry', data: {} };
            const enriched = enrichWithAgUi(event);

            expect(enriched).toEqual(event);
            expect(enriched.agui).toBeUndefined();
        });
    });
});
