import { memo, useEffect, useState, type ReactElement } from 'react';

interface IconProps { size?: number; className?: string }
const Pulse = ({ size = 12, className }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M3 12h4l3-9 4 18 3-9h4" />
  </svg>
);
const Lock = ({ size = 12, className }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </svg>
);
const Bolt = ({ size = 12, className }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
  </svg>
);
const Spinner = ({ size = 12, className }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" />
  </svg>
);
const Check = ({ size = 12, className }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);
const Anchor = ({ size = 12, className }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M18 6c0 4-4 7-7 7-3.3 0-6-2.7-6-6 0-1.7 1.3-3 3-3s3 1.3 3 3" /><path d="M11 13v6a2 2 0 0 0 4 0" />
  </svg>
);
const Alert = ({ size = 12, className }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M12 9v4M12 17h.01" /><circle cx="12" cy="12" r="9" />
  </svg>
);

interface LegendEntry { Icon: (p: IconProps) => ReactElement; label: string; meaning: string; tone: string }
const LEDGER_ENTRIES: LegendEntry[] = [
  { Icon: ({ size = 12, className }: IconProps) => (
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden><circle cx="12" cy="12" r="9" strokeDasharray="3 3" /></svg>
    ), label: 'Idle', meaning: 'Task registered but no agent has claimed it', tone: 'text-command-warm-white/60' },
  { Icon: Lock,    label: 'Reserved', meaning: 'Agent has reserved the task, dispatch imminent', tone: 'text-command-accent' },
  { Icon: Bolt,    label: 'Active',   meaning: 'Triad cycle currently running', tone: 'text-emerald-400' },
  { Icon: Spinner, label: 'Retrying', meaning: 'Failed cycle scheduled for re-dispatch with backoff', tone: 'text-amber-400' },
  { Icon: Check,   label: 'Complete', meaning: 'Cycle finished, ZTNP receipt issued', tone: 'text-cyan-300/80' },
];

const FEED_ENTRIES: LegendEntry[] = [
  { Icon: Pulse,    label: 'Phase',     meaning: 'Triad state machine transition (Architect → Operator → Verifier)', tone: 'text-command-accent' },
  { Icon: Anchor,   label: 'Hook',      meaning: 'Lifecycle hook outcome (after_create / before_run / after_run / before_remove)', tone: 'text-cyan-400' },
  { Icon: Spinner,  label: 'Retry',     meaning: 'Retry scheduled, dispatched, or exhausted', tone: 'text-amber-400' },
  { Icon: Alert,    label: 'Reconcile', meaning: 'Stall detected or terminal claim pruned', tone: 'text-red-400' },
];

interface BeaconLegendEntry { tone: string; label: string; meaning: string }
const BEACON_ENTRIES: BeaconLegendEntry[] = [
  { tone: 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)] animate-pulse', label: 'LIVE',      meaning: 'Beacon refreshed within the last 15 seconds. Agent process is healthy.' },
  { tone: 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)]',                  label: 'STALE',     meaning: '15–30s since the last beacon. Possible network blip or paused agent.' },
  { tone: 'bg-white/20 border border-white/10',                                  label: 'UNCLAIMED', meaning: 'No active beacon — the persona is on the roster but its agent process is not running.' },
];

export const StatusLegend = memo(() => {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // '?' triggers via Shift+/ on US layout
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target as HTMLElement | null;
        // Don't hijack while user is typing in an input
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        setOpen(v => !v);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Status legend (?)"
        aria-label="Show status legend"
        className="fixed bottom-14 left-4 z-40 w-9 h-9 rounded-full border border-white/10 bg-black/40 backdrop-blur-md text-command-warm-white/60 hover:text-command-warm-white hover:border-command-accent/40 hover:bg-command-accent/5 transition-colors flex items-center justify-center font-display font-bold text-[15px]"
      >
        ?
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="dialog"
            aria-label="Status legend"
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[500px] max-w-[90vw] max-h-[80vh] overflow-y-auto custom-scrollbar bg-[#0A0A09] border border-white/10 rounded-xl shadow-[0_24px_64px_-16px_rgba(0,0,0,0.7)]"
          >
            <header className="px-6 py-4 border-b border-white/5 flex items-start justify-between">
              <div>
                <div className="text-[10px] font-semibold tracking-wider text-command-warm-white/80 uppercase">Status Legend</div>
                <div className="font-display font-bold text-[16px] text-command-warm-white leading-tight mt-0.5">What the icons mean</div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md border border-white/10 text-command-warm-white/60 hover:text-command-warm-white hover:bg-white/5"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </header>
            <section className="px-6 py-4 space-y-4">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-command-warm-white/55 mb-2">Claim Ledger · Symphony §7</div>
                <ul className="space-y-1.5">
                  {LEDGER_ENTRIES.map((e) => (
                    <li key={e.label} className="flex items-center gap-3 py-1">
                      <e.Icon size={14} className={e.tone} />
                      <span className={`text-[12px] font-semibold ${e.tone} w-[80px]`}>{e.label}</span>
                      <span className="text-[11px] text-command-warm-white/65">{e.meaning}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="pt-3 border-t border-white/5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-command-warm-white/55 mb-2">System Feed kinds</div>
                <ul className="space-y-1.5">
                  {FEED_ENTRIES.map((e) => (
                    <li key={e.label} className="flex items-center gap-3 py-1">
                      <e.Icon size={14} className={e.tone} />
                      <span className={`text-[12px] font-semibold ${e.tone} w-[80px]`}>{e.label}</span>
                      <span className="text-[11px] text-command-warm-white/65">{e.meaning}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="pt-3 border-t border-white/5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-command-warm-white/55 mb-2">Chair Beacon · live presence</div>
                <ul className="space-y-1.5">
                  {BEACON_ENTRIES.map((e) => (
                    <li key={e.label} className="flex items-center gap-3 py-1">
                      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${e.tone}`} aria-hidden />
                      <span className="text-[12px] font-semibold text-command-warm-white w-[80px]">{e.label}</span>
                      <span className="text-[11px] text-command-warm-white/65">{e.meaning}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="pt-3 border-t border-white/5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-command-warm-white/55 mb-2">Mesh status</div>
                <ul className="space-y-1.5 text-[11px] text-command-warm-white/65">
                  <li><span className="text-emerald-300 font-semibold">Mesh healthy</span> — WS connected, agents registered, telemetry flowing</li>
                  <li><span className="text-amber-300 font-semibold">Syncing nodes</span> — WS connected, awaiting first agent_card frames</li>
                  <li><span className="text-red-300 font-semibold">Disconnected — retrying</span> — WS dropped, reconnecting with exponential backoff (500 ms → 30 s cap, jittered)</li>
                </ul>
              </div>
            </section>
            <footer className="px-6 py-3 border-t border-white/5 text-[10px] text-command-warm-white/40 flex items-center justify-between">
              <span>Press <kbd className="t-mono text-[10px] px-1.5 py-0.5 bg-white/5 rounded">?</kbd> to toggle · <kbd className="t-mono text-[10px] px-1.5 py-0.5 bg-white/5 rounded">Esc</kbd> to close</span>
              <span>Click any feed row for the full cycle</span>
            </footer>
          </div>
        </>
      )}
    </>
  );
});
StatusLegend.displayName = 'StatusLegend';

export default StatusLegend;
