import { memo, useMemo } from 'react';
import { GitBranch, ShieldAlert, Wrench } from 'lucide-react';
import { useWarRoomStore } from '../../store/useWarRoomStore';

interface CommitteeDrawerProps {
  topicId: string | null;
}

export const CommitteeDrawer = memo(({ topicId }: CommitteeDrawerProps) => {
  const verdicts = useWarRoomStore((s) => s.committeeVerdicts);
  const events = useWarRoomStore((s) => s.committeeEvents);
  const circuits = useWarRoomStore((s) => s.chairCircuits);
  const selfHealEvents = useWarRoomStore((s) => s.selfHealEvents);

  const verdict = topicId ? verdicts[topicId] : null;
  const topicEvents = useMemo(
    () => events.filter((event) => event.topicId === topicId).slice(0, 8),
    [events, topicId],
  );
  const openCircuits = Object.values(circuits).filter((circuit) => circuit.state !== 'closed');

  return (
    <aside className="w-72 shrink-0 border-l border-white/5 bg-black/20 min-h-0 flex flex-col">
      <div className="p-3 border-b border-white/5 flex items-center gap-2">
        <GitBranch className="w-4 h-4 text-command-accent" aria-hidden="true" />
        <span className="text-[10px] font-extrabold uppercase tracking-widest text-command-warm-white/60">
          COMMITTEE
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-thin">
        <section className="rounded-lg border border-white/5 bg-black/30 p-3">
          <div className="text-[9px] font-bold uppercase tracking-widest text-command-warm-white/40">
            VERDICT
          </div>
          {verdict ? (
            <div className="mt-2 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-extrabold uppercase text-command-warm-white">
                  {verdict.status.replace('_', ' ')}
                </span>
                <span className="font-mono text-[10px] text-command-accent">
                  {Math.round(verdict.confidenceMean * 100)}%
                </span>
              </div>
              <div className="h-1.5 rounded bg-white/10 overflow-hidden">
                <div
                  className="h-full bg-command-accent"
                  style={{ width: `${Math.round(verdict.supportScore * 100)}%` }}
                />
              </div>
              <div className="text-[10px] leading-relaxed text-command-warm-white/45">
                merge {verdict.trace?.mergeParentId ?? 'pending'} · dissent {verdict.dissent.length}
              </div>
            </div>
          ) : (
            <div className="mt-2 text-[10px] text-command-warm-white/30">No quorum receipt.</div>
          )}
        </section>

        <section className="rounded-lg border border-white/5 bg-black/30 p-3">
          <div className="text-[9px] font-bold uppercase tracking-widest text-command-warm-white/40">
            VOTES
          </div>
          <div className="mt-2 space-y-1.5">
            {topicEvents.length === 0 ? (
              <div className="text-[10px] text-command-warm-white/30">No committee traffic.</div>
            ) : (
              topicEvents.map((event) => (
                <div key={`${event.receivedAt}-${event.type}`} className="text-[10px] leading-relaxed text-command-warm-white/55">
                  {event.vote
                    ? `${event.vote.agentId}: ${event.vote.verdict} ${Math.round(event.vote.confidence * 100)}%`
                    : event.type}
                </div>
              ))
            )}
          </div>
        </section>

        <section className="rounded-lg border border-white/5 bg-black/30 p-3">
          <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-widest text-command-warm-white/40">
            <ShieldAlert className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
            CIRCUITS
          </div>
          <div className="mt-2 space-y-1.5">
            {openCircuits.length === 0 ? (
              <div className="text-[10px] text-command-warm-white/30">All closed.</div>
            ) : openCircuits.map((circuit) => (
              <div key={circuit.agentId} className="text-[10px] text-amber-200/80">
                {circuit.agentId}: {circuit.state} · {circuit.failures}
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-white/5 bg-black/30 p-3">
          <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-widest text-command-warm-white/40">
            <Wrench className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
            SELF-HEAL
          </div>
          <div className="mt-2 space-y-1.5">
            {selfHealEvents.length === 0 ? (
              <div className="text-[10px] text-command-warm-white/30">No repair loop.</div>
            ) : selfHealEvents.slice(0, 4).map((event) => (
              <div key={`${event.timestamp}-${event.type}`} className="text-[10px] text-command-warm-white/55">
                {event.type.replace('self_heal.', '')} · attempt {event.attempt}
              </div>
            ))}
          </div>
        </section>
      </div>
    </aside>
  );
});

CommitteeDrawer.displayName = 'CommitteeDrawer';
export default CommitteeDrawer;
