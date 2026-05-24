import { memo, useMemo, type ReactElement } from 'react';
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
  onSelectCycle: (cycleId: string) => void;
  height?: number;
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

interface IconProps { className?: string; size?: number }

const IconPhase = ({ className, size = 12 }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M3 12h4l3-9 4 18 3-9h4" />
  </svg>
);
const IconHook = ({ className, size = 12 }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M18 6c0 4-4 7-7 7-3.3 0-6-2.7-6-6 0-1.7 1.3-3 3-3s3 1.3 3 3" />
    <path d="M11 13v6a2 2 0 0 0 4 0" />
  </svg>
);
const IconRetry = ({ className, size = 12 }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" />
  </svg>
);
const IconReconcile = ({ className, size = 12 }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M12 9v4M12 17h.01" /><circle cx="12" cy="12" r="9" />
  </svg>
);

interface KindMeta {
  label: string;
  human: string;
  Icon: (p: IconProps) => ReactElement;
  pill: string;
}

const KIND_META: Record<UnifiedEvent['kind'], KindMeta> = {
  phase:     { label: 'PHASE',     human: 'Phase',     Icon: IconPhase,     pill: 'bg-command-accent/15 text-command-accent border-command-accent/25' },
  hook:      { label: 'HOOK',      human: 'Hook',      Icon: IconHook,      pill: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/25' },
  retry:     { label: 'RETRY',     human: 'Retry',     Icon: IconRetry,     pill: 'bg-amber-500/15 text-amber-300 border-amber-500/25' },
  reconcile: { label: 'RECONCILE', human: 'Reconcile', Icon: IconReconcile, pill: 'bg-red-500/15 text-red-300 border-red-500/25' },
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

// Map state-machine names to plain English for the primary text.
const HUMAN_LABEL: Record<string, string> = {
  // phase
  PreparingContext: 'Preparing context',
  DispatchToArchitect: 'Dispatching to Architect',
  ArchitectStreaming: 'Architect working',
  DispatchToOperator: 'Dispatching to Operator',
  OperatorExecuting: 'Operator running',
  DispatchToVerifier: 'Dispatching to Verifier',
  VerifierAuditing: 'Verifying',
  IssuingReceipt: 'Issuing receipt',
  Succeeded: 'Succeeded',
  Failed: 'Failed',
  Stalled: 'Stalled',
  // retry
  scheduled: 'Retry scheduled',
  dispatching: 'Retry dispatching',
  exhausted: 'Retries exhausted',
  // reconcile
  stall_detected: 'Stall detected',
  terminal_cleanup: 'Cleaned up',
};

function humanise(s: string): string { return HUMAN_LABEL[s] ?? s; }

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
      primary: humanise(p.phase),
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
      primary: `${humanise(h.event)} · ${h.name.split('.').pop()}`,
      secondary: h.success ? `${h.durationMs}ms` : (h.error ?? 'failed'),
      tone: h.success ? 'cyan' : 'red',
    });
  }
  for (const r of retry) {
    const att = r.dispatch?.attempt;
    out.push({
      kind: 'retry',
      timestamp: r.receivedAt,
      primary: humanise(r.kind),
      secondary: att != null ? `attempt ${att}` : (r.reason ?? ''),
      tone: r.kind === 'exhausted' ? 'red' : 'amber',
    });
  }
  for (const r of reconcile) {
    out.push({
      kind: 'reconcile',
      timestamp: r.timestamp,
      primary: humanise(r.kind),
      secondary: `was ${r.previousState} · ${Math.round(r.ageMs / 1000)}s`,
      tone: r.kind === 'stall_detected' ? 'red' : 'neutral',
    });
  }
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out.slice(0, 80);
}

const Row = memo(({ evt, onSelectCycle }: { evt: UnifiedEvent; onSelectCycle: (id: string) => void }) => {
  const time = new Date(evt.timestamp).toISOString().split('T')[1].split('.')[0];
  const meta = KIND_META[evt.kind];
  const clickable = !!evt.cycleId;
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onSelectCycle(evt.cycleId!) : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectCycle(evt.cycleId!); } } : undefined}
      className={`flex items-center gap-3 px-3.5 h-11 border-r border-white/5 shrink-0 transition-colors ${clickable ? 'cursor-pointer hover:bg-white/[0.04] focus:bg-white/[0.04] focus:outline-none' : 'hover:bg-white/[0.015]'}`}
      title={`${meta.label}${evt.cycleId ? ' · click to inspect cycle ' + evt.cycleId.slice(0, 8) : ''}`}
    >
      <span className="t-mono text-[10px] text-command-warm-white/45 tabular-nums">{time}</span>
      <span className={`inline-flex items-center gap-1.5 t-mono text-[8.5px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${meta.pill}`}>
        <meta.Icon size={11} />
        {meta.human}
      </span>
      {evt.agent && (
        <span className="t-mono text-[9.5px] uppercase tracking-wider px-1.5 py-0.5 bg-command-accent/10 text-command-accent/90 rounded border border-command-accent/15">
          {evt.agent}
        </span>
      )}
      <span className={`text-[12px] font-semibold ${TONE_CLASS[evt.tone]}`}>{evt.primary}</span>
      {evt.cycleId && (
        <span className="t-mono text-[9px] text-command-warm-white/30 tabular-nums">
          cycle&nbsp;{evt.cycleId.slice(0, 8)}
        </span>
      )}
      {evt.secondary && (
        <span className="text-[10.5px] text-command-warm-white/60 italic truncate max-w-[280px]">
          {evt.secondary}
        </span>
      )}
    </div>
  );
});
Row.displayName = 'PhaseFeed.Row';

export const PhaseFeed = memo(({ phaseEvents, hookEvents, retryEvents, reconcileActions, onSelectCycle, height = 44 }: PhaseFeedProps) => {
  const events = useMemo(
    () => unify(phaseEvents, hookEvents, retryEvents, reconcileActions),
    [phaseEvents, hookEvents, retryEvents, reconcileActions],
  );

  return (
    <footer
      data-layout-panel="system-feed"
      className="border-t border-white/5 bg-black/40 backdrop-blur-xl flex items-stretch relative z-20"
      style={{ height }}
    >
      <div className="px-4 flex items-center gap-2 border-r border-white/5 shrink-0">
        <div className="w-1.5 h-1.5 rounded-full bg-command-accent animate-pulse shadow-[0_0_8px_rgba(193,95,60,0.6)]" />
        <div className="flex flex-col items-start leading-none">
          <span className="text-[10px] font-semibold tracking-wider text-command-warm-white/85 uppercase">System Feed</span>
          <span className="text-[8px] mt-0.5 text-command-warm-white/40 font-medium">Latest {events.length}</span>
        </div>
      </div>
      <div className="flex-1 overflow-x-auto overflow-y-hidden custom-scrollbar flex items-stretch">
        {events.length === 0 ? (
          <div className="px-4 flex items-center text-[10.5px] text-command-warm-white/35 italic">
            Awaiting cycle events…
          </div>
        ) : (
          events.map((evt, i) => <Row key={`${evt.kind}-${evt.timestamp}-${i}`} evt={evt} onSelectCycle={onSelectCycle} />)
        )}
      </div>
    </footer>
  );
});
PhaseFeed.displayName = 'PhaseFeed';

export default PhaseFeed;
