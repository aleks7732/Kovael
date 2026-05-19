import { memo } from 'react';
import type { ClaimStats } from '../store/useWarRoomStore';

interface ClaimsStripProps {
  stats: ClaimStats;
  retryPending: number;
}

/**
 * ClaimsStrip — surfaces Symphony's 5-state claim machine on the cockpit.
 * Each bucket is one horizontal pill; the count is the live current state.
 * Sits below the TopBar so an operator can see at a glance whether the
 * mesh is healthy (Running > 0, RetryQueued ≈ 0) or stalled.
 */

const BUCKET_META: Array<{ key: keyof ClaimStats; label: string; dot: string; tone: string }> = [
  { key: 'Unclaimed',   label: 'UNCLAIMED',   dot: 'bg-white/30',                              tone: 'text-command-warm-white/60' },
  { key: 'Claimed',     label: 'CLAIMED',     dot: 'bg-command-accent',                        tone: 'text-command-accent' },
  { key: 'Running',     label: 'RUNNING',     dot: 'bg-emerald-500 shadow-[0_0_8px_rgba(52,211,153,0.5)] animate-pulse', tone: 'text-emerald-400' },
  { key: 'RetryQueued', label: 'RETRY_QUEUED',dot: 'bg-amber-500',                             tone: 'text-amber-400' },
  { key: 'Released',    label: 'RELEASED',    dot: 'bg-cyan-400/60',                           tone: 'text-cyan-300/80' },
];

export const ClaimsStrip = memo(({ stats, retryPending }: ClaimsStripProps) => {
  const total = BUCKET_META.reduce((sum, b) => sum + (stats[b.key] ?? 0), 0);

  return (
    <div className="h-9 px-5 flex items-center gap-3 border-b border-white/5 bg-black/20 backdrop-blur-md shrink-0 relative z-10">
      <div className="flex items-center gap-2 shrink-0">
        <div className="t-eyebrow">CLAIM_LEDGER</div>
        <span className="t-mono text-[8px] text-command-warm-white/40">symphony §7</span>
      </div>
      <div className="h-5 w-px bg-white/5" />
      <div className="flex items-center gap-2 flex-1 overflow-x-auto custom-scrollbar">
        {BUCKET_META.map((b) => {
          const n = stats[b.key] ?? 0;
          const dim = n === 0;
          return (
            <div
              key={b.key}
              className={`flex items-center gap-2 h-6 px-2 rounded-md border border-white/5 bg-black/30 ${dim ? 'opacity-40' : ''}`}
            >
              <div className={`w-1.5 h-1.5 rounded-full ${b.dot}`} />
              <span className="t-eyebrow !text-[7px]">{b.label}</span>
              <span className={`t-mono text-[11px] font-bold ${b.tone}`}>{n}</span>
            </div>
          );
        })}
      </div>
      <div className="shrink-0 flex items-center gap-3">
        <div className="flex items-center gap-1.5 t-mono text-[9px] text-command-warm-white/55">
          <span className="t-eyebrow !text-[7px]">RETRY_Q</span>
          <span className={`t-mono text-[11px] font-bold ${retryPending > 0 ? 'text-amber-400 glow-text' : 'text-command-warm-white/40'}`}>
            {retryPending}
          </span>
        </div>
        <div className="h-5 w-px bg-white/5" />
        <div className="t-mono text-[9px] text-command-warm-white/50">
          total <span className="text-command-warm-white font-bold">{total}</span>
        </div>
      </div>
    </div>
  );
});
ClaimsStrip.displayName = 'ClaimsStrip';

export default ClaimsStrip;
