import {
    CommitteeOptions,
    CommitteeVerdict,
    CommitteeVote,
    evaluateCommittee,
    synthesizeVotes,
} from './ConsensusEngine.js';

interface CommitteeTopic {
    participants: string[];
}

export interface CommitteeVotingDeps {
    topicFor(topicId: string): CommitteeTopic | undefined;
    emitBusEvent(event: Record<string, unknown>): void;
    postSummary(topicId: string, content: string): void;
}

export function conveneCommitteeVote(
    deps: CommitteeVotingDeps,
    topicId: string,
    goal: string,
    opts: CommitteeOptions & { votes?: CommitteeVote[] } = {},
): CommitteeVerdict {
    const active = deps.topicFor(topicId);
    if (!active) {
        throw Object.assign(new Error('committee_topic_not_active'), { code: 'committee_topic_not_active' });
    }
    const participants = [...active.participants];
    const votes = opts.votes ?? synthesizeVotes(goal, participants, opts.traceparent, opts.tracestate);
    deps.emitBusEvent({
        type: 'committee.started',
        topicId,
        goalPreview: goal.slice(0, 160),
        participants,
        traceparent: opts.traceparent,
        tracestate: opts.tracestate,
    });
    for (const vote of votes) {
        deps.emitBusEvent({
            type: 'committee.vote',
            topicId,
            vote,
        });
    }
    const verdict = evaluateCommittee(votes, {
        ...opts,
        activeParticipants: participants,
        sidecarCandidates: opts.sidecarCandidates ?? ['nyx-openclaw', 'shaev', 'nyx-codex'],
    });
    deps.emitBusEvent({
        type: verdict.status === 'accepted' ? 'committee.verdict' : 'committee.failed',
        topicId,
        verdict,
    });
    deps.postSummary(
        topicId,
        `Committee ${verdict.status}: support=${verdict.supportScore}, confidence=${verdict.confidenceMean}`,
    );
    return verdict;
}
