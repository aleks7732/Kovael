/**
 * AG-UI Event Stream — typed event names for the WebSocket bus.
 *
 * Adopts the AG-UI protocol event vocabulary so third-party cockpits
 * (Claude Desktop, Cursor, VS Code agent) can attach to Kovael's WS bus
 * and render agent activity without custom frame parsing.
 *
 * Today's internal bus events (conversation_topic_opened, conversation_message_delta,
 * etc.) are mapped to their AG-UI equivalents:
 *
 *   Internal event                    → AG-UI event
 *   ────────────────────────────────────────────────
 *   conversation_topic_opened         → run.started
 *   conversation_message_delta        → message.delta
 *   conversation_message_delta(isEnd) → step.finished
 *   conversation_stopping_criterion   → run.finished
 *   conversation_topic_closed         → run.finished
 *   phase_change                      → step.started / step.finished
 *   cycle_complete                    → run.finished
 *
 * The mapper preserves the original internal event unchanged and adds a
 * parallel `agui` envelope for AG-UI consumers.
 */

export interface AgUiEvent {
    /** AG-UI event type. */
    type: AgUiEventType;
    /** Unique run/conversation identifier. */
    runId: string;
    /** Timestamp in epoch ms. */
    timestamp: number;
    /** Event-specific payload. */
    data: Record<string, unknown>;
}

export type AgUiEventType =
    | 'run.started'
    | 'run.finished'
    | 'step.started'
    | 'step.finished'
    | 'message.delta'
    | 'message.completed'
    | 'tool.call'
    | 'tool.result'
    | 'error';

/**
 * Maps an internal bus event to an AG-UI typed event.
 * Returns null when no mapping applies (caller skips AG-UI broadcast).
 */
export function mapToAgUi(internalEvent: Record<string, unknown>): AgUiEvent | null {
    const type = internalEvent.type as string | undefined;
    if (!type) return null;

    const now = Date.now();

    switch (type) {
        case 'conversation_topic_opened': {
            const topic = internalEvent.topic as Record<string, unknown> | undefined;
            return {
                type: 'run.started',
                runId: (topic?.id as string) ?? '',
                timestamp: now,
                data: {
                    title: topic?.title ?? '',
                    participants: topic?.participants ?? [],
                },
            };
        }

        case 'conversation_message_delta': {
            const isEnd = internalEvent.isEnd as boolean;
            if (isEnd) {
                return {
                    type: 'step.finished',
                    runId: (internalEvent.topicId as string) ?? '',
                    timestamp: now,
                    data: {
                        messageId: internalEvent.messageId,
                        senderId: internalEvent.senderId,
                        role: internalEvent.role,
                        usage: internalEvent.usage,
                    },
                };
            }
            return {
                type: 'message.delta',
                runId: (internalEvent.topicId as string) ?? '',
                timestamp: now,
                data: {
                    messageId: internalEvent.messageId,
                    senderId: internalEvent.senderId,
                    delta: internalEvent.delta,
                    role: internalEvent.role,
                },
            };
        }

        case 'conversation_stopping_criterion': {
            return {
                type: 'run.finished',
                runId: (internalEvent.topicId as string) ?? '',
                timestamp: now,
                data: {
                    reason: internalEvent.reason,
                    confidence: internalEvent.confidence,
                    agentId: internalEvent.agentId,
                },
            };
        }

        case 'conversation_topic_closed': {
            return {
                type: 'run.finished',
                runId: (internalEvent.topicId as string) ?? '',
                timestamp: now,
                data: { reason: 'topic_closed' },
            };
        }

        default:
            return null;
    }
}

/**
 * Wrap an internal event in an AG-UI envelope.
 * Returns the original event augmented with an `agui` field,
 * or the original event unchanged if no mapping applies.
 */
export function enrichWithAgUi(internalEvent: Record<string, unknown>): Record<string, unknown> {
    const agui = mapToAgUi(internalEvent);
    if (!agui) return internalEvent;
    return { ...internalEvent, agui };
}
