import { describe, expect, it } from 'vitest';
import { evaluateCommittee, synthesizeVotes } from '../services/ConsensusEngine.js';

describe('ConsensusEngine', () => {
    it('accepts quorum only when weighted support and mean confidence clear threshold', () => {
        const result = evaluateCommittee([
            { agentId: 'a', role: 'proponent', verdict: 'approve', confidence: 0.95, weight: 1, rationale: 'ok' },
            { agentId: 'b', role: 'critic', verdict: 'approve', confidence: 0.9, weight: 1, rationale: 'ok' },
            { agentId: 'c', role: 'judge', verdict: 'approve', confidence: 0.92, weight: 1.5, rationale: 'ok' },
        ]);

        expect(result.status).toBe('accepted');
        expect(result.supportScore).toBeGreaterThanOrEqual(0.9);
        expect(result.confidenceMean).toBeGreaterThanOrEqual(0.85);
        expect(result.dissent).toHaveLength(0);
    });

    it('keeps dissent and suggests sidecars when confidence collapses below failure threshold', () => {
        const result = evaluateCommittee([
            { agentId: 'a', role: 'proponent', verdict: 'approve', confidence: 0.4, rationale: 'weak' },
            { agentId: 'b', role: 'critic', verdict: 'reject', confidence: 0.45, rationale: 'bad' },
        ], {
            activeParticipants: ['a', 'b'],
            sidecarCandidates: ['b', 'nyx-openclaw', 'shaev'],
        });

        expect(result.status).toBe('needs_sidecar');
        expect(result.dissent.map((vote) => vote.agentId)).toEqual(['b']);
        expect(result.sidecars).toEqual(['nyx-openclaw', 'shaev']);
    });

    it('does not allow callers to weaken quorum below policy minimum', () => {
        const result = evaluateCommittee([
            { agentId: 'a', role: 'proponent', verdict: 'reject', confidence: 1, weight: 1, rationale: 'no' },
        ], {
            quorumThreshold: 0,
            failureThreshold: 0,
            activeParticipants: ['a'],
        });

        expect(result.quorumThreshold).toBe(0.6);
        expect(result.failureThreshold).toBe(0.5);
        expect(result.status).not.toBe('accepted');
    });

    it('counts missing active participants as abstentions', () => {
        const result = evaluateCommittee([
            { agentId: 'a', role: 'proponent', verdict: 'approve', confidence: 1, weight: 1, rationale: 'solo approve' },
        ], {
            quorumThreshold: 0.85,
            activeParticipants: ['a', 'b', 'c'],
        });

        expect(result.status).not.toBe('accepted');
        expect(result.abstainWeight).toBe(2);
        expect(result.dissent.map((vote) => vote.agentId)).toEqual(['b', 'c']);
    });

    it('preserves traceparent and creates deterministic merge lane metadata', () => {
        const traceparent = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
        const votes = synthesizeVotes('trace split', ['nyx-codex', 'shaev'], traceparent, 'vendor=a');
        const result = evaluateCommittee(votes, { traceparent, tracestate: 'vendor=a' });

        expect(result.trace.traceparent).toBe(traceparent);
        expect(result.trace.tracestate).toBe('vendor=a');
        expect(result.trace.mergeParentId).toHaveLength(16);
        expect(result.trace.lanes).toHaveLength(2);
        expect(result.trace.lanes[0].laneId).toBe('committee-lane-1');
        expect(result.trace.lanes[0].traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
        expect(result.trace.lanes[0].traceparent).not.toBe(traceparent);
        expect(result.trace.lanes[1].traceparent).not.toBe(traceparent);
        expect(result.trace.lanes[0].traceparent).not.toBe(result.trace.lanes[1].traceparent);
    });

    it('omits invalid W3C trace headers', () => {
        const votes = synthesizeVotes('trace split', ['nyx-codex'], '00-root-parent', 'bad\nstate');
        const result = evaluateCommittee(votes, { traceparent: '00-root-parent', tracestate: 'bad\nstate' });

        expect(result.trace.traceparent).toBeUndefined();
        expect(result.trace.tracestate).toBeUndefined();
        expect(result.trace.lanes[0].traceparent).toBeUndefined();
    });
});
