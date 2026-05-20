import { memo, useEffect, useState } from 'react';
import type { PhaseEvent } from '../store/useWarRoomStore';

interface ToastStackProps {
  phaseEvents: PhaseEvent[];
}

/**
 * ToastStack — peripheral-awareness layer.
 *
 * When a Triad cycle reaches a terminal phase (Succeeded / Failed / Stalled)
 * a slide-in toast appears bottom-right, holds for 4s, then fades out.
 * Operators looking at the canvas (not the SYSTEM_FEED) still get the
 * "what just resolved" signal.
 *
 * Stateless: derives toasts directly from `phaseEvents`. We just filter
 * the most recent terminal events that landed within the last DISPLAY_MS,
 * subtract any the user has dismissed locally. Re-renders on every store
 * tick — cheap because PhaseFeed already memoizes the source array.
 */

const DISPLAY_MS = 4000;
const TERMINAL = new Set(['Succeeded', 'Failed', 'Stalled']);

interface ToastSpec {
  cycleId: string;
  phase: 'Succeeded' | 'Failed' | 'Stalled';
  agent?: string;
  timestamp: number;
}

interface IconProps { size?: number; className?: string }
const IconCheck = ({ size = 14, className }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);
const IconX = ({ size = 14, className }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);
const IconAlert = ({ size = 14, className }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M12 9v4M12 17h.01" /><circle cx="12" cy="12" r="9" />
  </svg>
);

const TONE: Record<ToastSpec['phase'], { ring: string; bg: string; text: string; Icon: (p: IconProps) => ReturnType<typeof IconCheck>; label: string }> = {
  Succeeded: { ring: 'border-emerald-500/40', bg: 'bg-emerald-500/15', text: 'text-emerald-200', Icon: IconCheck, label: 'Mission complete' },
  Failed:    { ring: 'border-red-500/40',     bg: 'bg-red-500/15',     text: 'text-red-200',     Icon: IconX,     label: 'Mission failed' },
  Stalled:   { ring: 'border-amber-500/40',   bg: 'bg-amber-500/15',   text: 'text-amber-200',   Icon: IconAlert, label: 'Mission stalled' },
};

export const ToastStack = memo(({ phaseEvents }: ToastStackProps) => {
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const toasts: ToastSpec[] = [];
  for (const e of phaseEvents) {
    if (!TERMINAL.has(e.phase)) continue;
    if (now - e.timestamp > DISPLAY_MS) continue;
    const key = `${e.cycleId}-${e.phase}`;
    if (dismissed.has(key)) continue;
    toasts.push({
      cycleId: e.cycleId,
      phase: e.phase as ToastSpec['phase'],
      agent: e.routedAgent,
      timestamp: e.timestamp,
    });
    if (toasts.length >= 3) break;
  }

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-14 right-4 z-40 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => {
        const tone = TONE[t.phase];
        const ageMs = now - t.timestamp;
        const remaining = Math.max(0, 1 - ageMs / DISPLAY_MS);
        return (
          <div
            key={`${t.cycleId}-${t.phase}`}
            className={`pointer-events-auto relative overflow-hidden min-w-[260px] max-w-[340px] rounded-lg border ${tone.ring} ${tone.bg} backdrop-blur-xl px-3.5 py-2.5 shadow-[0_8px_32px_-8px_rgba(0,0,0,0.6)] flex items-center gap-3`}
            role="status"
          >
            <tone.Icon size={16} className={tone.text} />
            <div className="flex-1 min-w-0">
              <div className={`text-[12px] font-semibold ${tone.text}`}>
                {tone.label}{t.agent ? ` · ${t.agent}` : ''}
              </div>
              <div className="t-mono text-[9px] text-command-warm-white/45 tabular-nums truncate">
                cycle {t.cycleId.slice(0, 12)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setDismissed((d) => new Set(d).add(`${t.cycleId}-${t.phase}`))}
              className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-command-warm-white/40 hover:text-command-warm-white/80 hover:bg-white/5"
              aria-label="Dismiss"
            >
              <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
            {/* slim countdown bar */}
            <div className="absolute left-0 bottom-0 h-px bg-current opacity-30" style={{ width: `${remaining * 100}%` }} />
          </div>
        );
      })}
    </div>
  );
});
ToastStack.displayName = 'ToastStack';

export default ToastStack;
