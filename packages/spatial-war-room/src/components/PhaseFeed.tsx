import { memo, useMemo } from 'react';
import type {
  PhaseEvent,
  HookEvent,
  RetryEvent,
  ReconcileAction,
} from '../store/useWarRoomStore';

interface PhaseFeedProps {
  phaseEvents: PhaseEvent[];
  hookEvents: HookEvent[];
  retryEvents: RetryEvent[];
  reconcileActions: ReconcileAction[];
}

interface UnifiedEvent {
  kind: 'phase' | 'hook' | 'retry' | 'reconcile';
  timestamp: number;
  primary: string;
  secondary?: string;
  agent?: string;
  cycleId?: string;
  tone: 'accent' | 'amber' | 'cyan' | 'emerald' | 'red' | 'neutral';
}

const KIND_META: Record<UnifiedEvent['kind'], { label: string; pill: string }> = {
  phase:     { label: 'PHASE',     pill: 'bg-command-accent/15 text-command-accent' },
  hook:      { label: 'HOOK',      pill: 'bg-cyan-500/15 text-cyan-300' },
  retry:     { label: 'RETRY',     pill: 'bg-amber-500/15 text-amber-300' },
  reconcile: { label: 'RECONCILE', pill: 'bg-red-500/15 text-red-300' },
};

const TONE_CLASS: Record<UnifiedEvent['tone'], string> = {
  accent:  'text-command-accent glow-text',
  amber:   'text-amber-400',
  cyan:    'text-cyan-400',
  emerald: 'text-emerald-400 glow-text',
  red:     'text-red-400',
  neutral: 'text-command-warm-white/70',
};

const PHASE_TONE: Record<string, UnifiedEvent['tone']> = {
  Succeeded: 'emerald',
  Failed:    'red',
  Stalled:   'red',
};

function unify(
  phase: PhaseEvent[],
  hook: HookEvent[],
  retry: RetryEvent[],
  reconcile: ReconcileAction[],
): UnifiedEvent[] {
  const out: UnifiedEvent[] = [];
  for (const p of phase) {
    out.push({
      kind: 'phase',
      timestamp: p.timestamp,
      primary: p.phase,
      secondary: p.note,
      agent: p.routedAgent,
      cycleId: p.cycleId,
      tone: PHASE_TONE[p.phase] ?? 'accent',
    });
  }
  for (const h of hook) {
    out.push({
      kind: 'hook',
      timestamp: h.receivedAt,
      primary: `${h.event}:${h.name.split('.').pop()}`,
      secondary: h.success ? `${h.durationMs}ms` : (h.error ?? 'failed'),
      tone: h.success ? 'cyan' : 'red',
    });
  }
  for (const r of retry) {
    const att = r.dispatch?.attempt;
    out.push({
      kind: 'retry',
      timestamp: r.receivedAt,
      primary: r.kind,
      secondary: att != null ? `attempt ${att}` : (r.reason ?? ''),
      tone: r.kind === 'exhausted' ? 'red' : 'amber',
    });
  }
  for (const r of reconcile) {
    out.push({
      kind: 'reconcile',
      timestamp: r.timestamp,
      primary: r.kind,
      secondary: `was ${r.previousState} · ${Math.round(r.ageMs / 1000)}s`,
      tone: r.kind === 'stall_detected' ? 'red' : 'neutral',
    });
  }
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out.slice(0, 80);
}

const Row = memo(({ evt }: { evt: UnifiedEvent }) => {
  const time = new Date(evt.timestamp).toISOString().split('T')[1].split('.')[0];
  const meta = KIND_META[evt.kind];
  return (
    <div className="flex items-center gap-3 px-3 h-7 border-r border-white/5 shrink-0">
      <span className="t-mono text-[9px] text-command-warm-white/40">{time}</span>
      <span className={`t-mono text-[8px] uppercase tracking-wider px-1.5 py-0.5 rounded ${meta.pill}`}>
        {meta.label}
      </span>
      {evt.agent && (
        <span className="t-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 bg-command-accent/10 text-command-accent/90 rounded">
          {evt.agent}
        </span>
      )}
      <span className={`t-mono text-[10px] font-bold ${TONE_CLASS[evt.tone]}`}>{evt.primary}</span>
      {evt.cycleId && (
        <span className="t-mono text-[8px] text-command-warm-white/30">
          cycle:{evt.cycleId.slice(0, 8)}
        </span>
      )}
      {evt.secondary && (
        <span className="t-mono text-[9px] text-command-warm-white/55 italic truncate max-w-[260px]">
          {evt.secondary}
        </span>
      )}
    </div>
  );
});
Row.displayName = 'PhaseFeed.Row';

export const PhaseFeed = memo(({ phaseEvents, hookEvents, retryEvents, reconcileActions }: PhaseFeedProps) => {
  const events = useMemo(
    () => unify(phaseEvents, hookEvents, retryEvents, reconcileActions),
    [phaseEvents, hookEvents, retryEvents, reconcileActions],
  );

  return (
    <footer className="h-9 border-t border-white/5 bg-black/40 backdrop-blur-xl flex items-stretch relative z-20">
      <div className="px-4 flex items-center gap-2 border-r border-white/5 shrink-0">
        <div className="w-1.5 h-1.5 rounded-full bg-command-accent animate-pulse shadow-[0_0_8px_rgba(193,95,60,0.6)]" />
        <span className="t-eyebrow">SYSTEM_FEED</span>
      </div>
      <div className="flex-1 overflow-x-auto overflow-y-hidden custom-scrollbar flex items-stretch">
        {events.length === 0 ? (
          <div className="px-3 flex items-center t-mono text-[9px] text-command-warm-white/30 italic">
            awaiting cycle events…
          </div>
        ) : (
          events.map((evt, i) => <Row key={`${evt.kind}-${evt.timestamp}-${i}`} evt={evt} />)
        )}
      </div>
    </footer>
  );
});
PhaseFeed.displayName = 'PhaseFeed';

export default PhaseFeed;
