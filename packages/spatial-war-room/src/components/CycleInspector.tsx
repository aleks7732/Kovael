import { memo, useEffect, useMemo } from 'react';
import type { PhaseEvent, HookEvent } from '../store/useWarRoomStore';

interface CycleInspectorProps {
  cycleId: string | null;
  phaseEvents: PhaseEvent[];
  hookEvents: HookEvent[];
  onClose: () => void;
}

const PHASE_HUMAN: Record<string, string> = {
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
};

const PHASE_TONE: Record<string, { dot: string; text: string }> = {
  Succeeded: { dot: 'bg-emerald-500 shadow-[0_0_8px_rgba(52,211,153,0.6)]', text: 'text-emerald-300' },
  Failed:    { dot: 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]',     text: 'text-red-300'     },
  Stalled:   { dot: 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]',  text: 'text-amber-300'   },
};
const DEFAULT_TONE = { dot: 'bg-command-accent', text: 'text-command-accent' };

const TERMINAL = new Set(['Succeeded', 'Failed', 'Stalled']);

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

function formatTime(ts: number): string {
  return new Date(ts).toISOString().split('T')[1].split('.')[0];
}

export const CycleInspector = memo(({ cycleId, phaseEvents, hookEvents, onClose }: CycleInspectorProps) => {
  // Escape key closes the drawer.
  useEffect(() => {
    if (!cycleId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cycleId, onClose]);

  const data = useMemo(() => {
    if (!cycleId) return null;
    const phases = phaseEvents.filter(e => e.cycleId === cycleId).slice().sort((a, b) => a.timestamp - b.timestamp);
    if (phases.length === 0) return null;
    const hooks = hookEvents.filter(h => phases.some(p => p.taskHash && h.event)).slice(0, 8); // best-effort scope
    const startedAt = phases[0].timestamp;
    const latest = phases[phases.length - 1];
    const isComplete = TERMINAL.has(latest.phase);
    const totalMs = (isComplete ? latest.timestamp : Date.now()) - startedAt;
    const agent = phases.find(p => p.routedAgent)?.routedAgent;
    const taskHash = phases[0].taskHash;
    return { phases, hooks, startedAt, isComplete, totalMs, agent, taskHash, latest };
  }, [cycleId, phaseEvents, hookEvents]);

  if (!cycleId || !data) return null;

  const headerTone = data.latest.phase === 'Failed' || data.latest.phase === 'Stalled'
    ? 'border-red-500/40 bg-red-500/5'
    : data.isComplete
    ? 'border-emerald-500/40 bg-emerald-500/5'
    : 'border-command-accent/40 bg-command-accent/5';

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label="Cycle Inspector"
        className="fixed right-0 top-0 bottom-0 z-50 w-[420px] bg-[#0A0A09] border-l border-white/10 shadow-[-12px_0_48px_-12px_rgba(0,0,0,0.7)] flex flex-col"
      >
        <header className={`px-5 py-4 border-b ${headerTone} flex items-start justify-between gap-3`}>
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="text-[10px] font-semibold tracking-wider text-command-warm-white/80 uppercase">Cycle Inspector</div>
            <div className="font-display font-bold text-[15px] text-command-warm-white truncate">
              {PHASE_HUMAN[data.latest.phase] ?? data.latest.phase}
            </div>
            <div className="t-mono text-[10px] text-command-warm-white/45 tabular-nums truncate">
              {cycleId}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close inspector"
            className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md border border-white/10 text-command-warm-white/60 hover:text-command-warm-white hover:bg-white/5 transition-colors"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="grid grid-cols-3 gap-px bg-white/5 border-b border-white/5">
          <div className="bg-[#0A0A09] px-3 py-2.5">
            <div className="text-[8.5px] font-semibold uppercase tracking-wide text-command-warm-white/50">Agent</div>
            <div className="t-mono text-[12px] text-command-warm-white font-bold mt-0.5">{data.agent ?? '—'}</div>
          </div>
          <div className="bg-[#0A0A09] px-3 py-2.5">
            <div className="text-[8.5px] font-semibold uppercase tracking-wide text-command-warm-white/50">Phases</div>
            <div className="t-mono text-[12px] text-command-warm-white font-bold mt-0.5 tabular-nums">{data.phases.length}</div>
          </div>
          <div className="bg-[#0A0A09] px-3 py-2.5">
            <div className="text-[8.5px] font-semibold uppercase tracking-wide text-command-warm-white/50">Total</div>
            <div className="t-mono text-[12px] text-command-warm-white font-bold mt-0.5 tabular-nums">{formatMs(data.totalMs)}</div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar px-5 py-4">
          <div className="text-[10px] font-semibold tracking-wider text-command-warm-white/70 uppercase mb-3">Phase Timeline</div>
          <ol className="relative space-y-3 pl-5 before:absolute before:left-[5px] before:top-1 before:bottom-1 before:w-px before:bg-white/10">
            {data.phases.map((p, i) => {
              const tone = PHASE_TONE[p.phase] ?? DEFAULT_TONE;
              const prev = i > 0 ? data.phases[i - 1].timestamp : data.startedAt;
              const dt = p.timestamp - prev;
              return (
                <li key={`${p.cycleId}-${p.timestamp}-${i}`} className="relative">
                  <span className={`absolute -left-5 top-1 w-2.5 h-2.5 rounded-full ${tone.dot}`} />
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`text-[12px] font-semibold ${tone.text}`}>
                      {PHASE_HUMAN[p.phase] ?? p.phase}
                    </span>
                    <span className="t-mono text-[9px] text-command-warm-white/35 tabular-nums shrink-0">
                      +{formatMs(dt)}
                    </span>
                  </div>
                  <div className="t-mono text-[9.5px] text-command-warm-white/50 tabular-nums mt-0.5">
                    {formatTime(p.timestamp)}
                    {p.routedAgent && <span className="ml-2 text-command-accent/80">→ {p.routedAgent}</span>}
                  </div>
                  {p.note && (
                    <div className="text-[10px] text-command-warm-white/55 italic mt-1 break-all">
                      {p.note}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>

          <div className="mt-6 pt-4 border-t border-white/5">
            <div className="text-[10px] font-semibold tracking-wider text-command-warm-white/70 uppercase mb-2">Task Hash</div>
            <div className="t-mono text-[10px] text-command-warm-white/55 break-all">{data.taskHash}</div>
          </div>
        </div>

        <footer className="px-5 py-3 border-t border-white/5 text-[9.5px] text-command-warm-white/40 flex items-center justify-between">
          <span>Press <kbd className="t-mono text-[9px] px-1 bg-white/5 rounded">Esc</kbd> to close</span>
          <span className="t-mono tabular-nums">{formatTime(data.startedAt)}</span>
        </footer>
      </aside>
    </>
  );
});
CycleInspector.displayName = 'CycleInspector';

export default CycleInspector;
