import crypto from 'node:crypto';

export interface TraceContextEnvelope {
    traceparent?: string;
    tracestate?: string;
    laneId?: string;
    mergeParentId?: string;
}

export interface CommitteeVote {
    agentId: string;
    role: 'proponent' | 'critic' | 'judge';
    verdict: 'approve' | 'reject' | 'abstain';
    confidence: number;
    weight?: number;
    rationale: string;
    trace?: TraceContextEnvelope;
}

export interface CommitteeOptions {
    quorumThreshold?: number;
    failureThreshold?: number;
    sidecarCandidates?: string[];
    activeParticipants?: string[];
    traceparent?: string;
    tracestate?: string;
}

export interface CommitteeVerdict {
    id: string;
    status: 'accepted' | 'failed' | 'needs_sidecar';
    quorumThreshold: number;
    failureThreshold: number;
    supportScore: number;
    confidenceMean: number;
    weightedVotes: number;
    approveWeight: number;
    rejectWeight: number;
    abstainWeight: number;
    dissent: CommitteeVote[];
    sidecars: string[];
    trace: {
        traceparent?: string;
        tracestate?: string;
        mergeParentId: string;
        lanes: TraceContextEnvelope[];
    };
}

const DEFAULT_QUORUM = 0.85;
const DEFAULT_FAILURE = 0.5;
const MIN_QUORUM = 0.6;
const MIN_FAILURE = 0.5;
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function evaluateCommittee(votes: CommitteeVote[], options: CommitteeOptions = {}): CommitteeVerdict {
    const quorumThreshold = clampRange(options.quorumThreshold ?? DEFAULT_QUORUM, MIN_QUORUM, 1);
    const failureThreshold = clampRange(options.failureThreshold ?? DEFAULT_FAILURE, MIN_FAILURE, quorumThreshold);
    const normalized = completeParticipantVotes(votes, options.activeParticipants).map(normalizeVote);
    const weights = normalized.map((vote) => vote.weight);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const approveWeight = normalized.reduce((sum, vote, index) => sum + (vote.verdict === 'approve' ? weights[index] * vote.confidence : 0), 0);
    const rejectWeight = normalized.reduce((sum, vote, index) => sum + (vote.verdict === 'reject' ? weights[index] * vote.confidence : 0), 0);
    const abstainWeight = normalized.reduce((sum, vote, index) => sum + (vote.verdict === 'abstain' ? weights[index] : 0), 0);
    const supportScore = totalWeight === 0 ? 0 : approveWeight / totalWeight;
    const confidenceMean = normalized.length === 0
        ? 0
        : normalized.reduce((sum, vote) => sum + vote.confidence, 0) / normalized.length;
    const status = supportScore >= quorumThreshold && confidenceMean >= quorumThreshold
        ? 'accepted'
        : supportScore < failureThreshold || confidenceMean < failureThreshold
            ? 'needs_sidecar'
            : 'failed';
    const active = new Set(options.activeParticipants ?? normalized.map((vote) => vote.agentId));
    const sidecars = status === 'needs_sidecar'
        ? (options.sidecarCandidates ?? []).filter((candidate) => !active.has(candidate)).slice(0, 2)
        : [];
    const traceparent = sanitizeTraceparent(options.traceparent);
    const tracestate = sanitizeTracestate(options.tracestate);
    const mergeParentId = crypto
        .createHash('sha256')
        .update(JSON.stringify({ votes: normalized, traceparent: traceparent ?? '' }))
        .digest('hex')
        .slice(0, 16);

    return {
        id: crypto.randomUUID(),
        status,
        quorumThreshold,
        failureThreshold,
        supportScore: round4(supportScore),
        confidenceMean: round4(confidenceMean),
        weightedVotes: round4(totalWeight),
        approveWeight: round4(approveWeight),
        rejectWeight: round4(rejectWeight),
        abstainWeight: round4(abstainWeight),
        dissent: normalized.filter((vote) => vote.verdict !== 'approve'),
        sidecars,
        trace: {
            traceparent,
            tracestate,
            mergeParentId,
            lanes: normalized.map((vote, index) => ({
                traceparent: makeLaneTraceparent(sanitizeTraceparent(vote.trace?.traceparent) ?? traceparent, mergeParentId, index),
                tracestate: sanitizeTracestate(vote.trace?.tracestate) ?? tracestate,
                laneId: vote.trace?.laneId ?? `committee-lane-${index + 1}`,
                mergeParentId,
            })),
        },
    };
}

export function synthesizeVotes(goal: string, participants: string[], traceparent?: string, tracestate?: string): CommitteeVote[] {
    const parent = sanitizeTraceparent(traceparent);
    const state = sanitizeTracestate(tracestate);
    return participants.map((agentId, index) => {
        const hash = crypto.createHash('sha256').update(`${goal}:${agentId}:${index}`).digest();
        const confidence = 0.62 + (hash[0] / 255) * 0.34;
        const approve = hash[1] >= 48;
        return {
            agentId,
            role: index === 0 ? 'proponent' : index === participants.length - 1 ? 'judge' : 'critic',
            verdict: approve ? 'approve' : 'reject',
            confidence: round4(confidence),
            weight: index === participants.length - 1 ? 1.35 : 1,
            rationale: approve ? 'proposal clears local evidence gate' : 'dissent retained for verifier review',
            trace: {
                traceparent: parent,
                tracestate: state,
                laneId: `committee-lane-${index + 1}`,
            },
        };
    });
}

function completeParticipantVotes(votes: CommitteeVote[], activeParticipants?: string[]): CommitteeVote[] {
    if (!activeParticipants || activeParticipants.length === 0) return votes;
    const byAgent = new Map(votes.map((vote) => [vote.agentId, vote]));
    const completed = activeParticipants.map((agentId, index) => byAgent.get(agentId) ?? ({
        agentId,
        role: index === 0 ? 'proponent' as const : 'critic' as const,
        verdict: 'abstain' as const,
        confidence: 0,
        weight: 1,
        rationale: 'missing committee vote counted as abstain',
    }));
    completed.push(...votes.filter((vote) => !activeParticipants.includes(vote.agentId)));
    return completed;
}

function normalizeVote(vote: CommitteeVote): CommitteeVote & { weight: number } {
    return {
        ...vote,
        confidence: clamp01(vote.confidence),
        weight: Math.max(0, Number.isFinite(vote.weight ?? 1) ? vote.weight ?? 1 : 1),
        rationale: vote.rationale.slice(0, 500),
    };
}

function clampRange(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
    return clampRange(value, 0, 1);
}

function round4(value: number): number {
    return Math.round(value * 10_000) / 10_000;
}

export function sanitizeTraceparent(value?: string): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim().toLowerCase();
    const match = TRACEPARENT_RE.exec(trimmed);
    if (!match) return undefined;
    if (/^0+$/.test(match[1]) || /^0+$/.test(match[2])) return undefined;
    return trimmed;
}

export function sanitizeTracestate(value?: string): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 512 || /[\r\n]/.test(trimmed)) return undefined;
    return trimmed;
}

function makeLaneTraceparent(parent: string | undefined, mergeParentId: string, index: number): string | undefined {
    if (!parent) return undefined;
    const match = TRACEPARENT_RE.exec(parent);
    if (!match) return undefined;
    let spanId = crypto.createHash('sha256').update(`${mergeParentId}:${index}`).digest('hex').slice(0, 16);
    if (/^0+$/.test(spanId)) spanId = '0000000000000001';
    return `00-${match[1]}-${spanId}-${match[3]}`;
}
