import { memo, type ReactElement } from 'react';
import type { ClaimStats } from '../store/useWarRoomStore';

interface ClaimsStripProps {
  stats: ClaimStats;
  retryPending: number;
}

/**
 * ClaimsStrip — Symphony §7 claim machine, made for humans.
 *
 * Each of the five states gets:
 *   - a glanceable icon
 *   - a BIG count (14px, the primary signal)
 *   - a plain-English label ("Idle" / "Reserved" / "Active" / "Retrying" / "Complete")
 *   - the state-machine ID accessible on hover (title attribute)
 *
 * Empty buckets fade to 40% opacity. RetryQueue depth only shows when > 0
 * so quiet meshes stay quiet.
 */

interface IconProps { className?: string; size?: number }

const IconIdle = ({ className, size = 14 }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
  </svg>
);
const IconReserved = ({ className, size = 14 }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </svg>
);
const IconActive = ({ className, size = 14 }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
  </svg>
);
const IconRetrying = ({ className, size = 14 }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </svg>
);
const IconComplete = ({ className, size = 14 }: IconProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

interface BucketMeta {
  key: keyof ClaimStats;
  human: string;
  state: string;
  Icon: (p: IconProps) => ReactElement;
  accent: string;
  iconPulse?: boolean;
}

const BUCKETS: BucketMeta[] = [
  { key: 'Unclaimed',   human: 'Idle',     state: 'UNCLAIMED',    Icon: IconIdle,     accent: 'text-command-warm-white/60' },
  { key: 'Claimed',     human: 'Reserved', state: 'CLAIMED',      Icon: IconReserved, accent: 'text-command-accent' },
  { key: 'Running',     human: 'Active',   state: 'RUNNING',      Icon: IconActive,   accent: 'text-emerald-400',         iconPulse: true },
  { key: 'RetryQueued', human: 'Retrying', state: 'RETRY_QUEUED', Icon: IconRetrying, accent: 'text-amber-400' },
  { key: 'Released',    human: 'Complete', state: 'RELEASED',     Icon: IconComplete, accent: 'text-cyan-300/80' },
];

export const ClaimsStrip = memo(({ stats, retryPending }: ClaimsStripProps) => {
  const total = BUCKETS.reduce((sum, b) => sum + (stats[b.key] ?? 0), 0);

  return (
    <div className="h-12 px-5 flex items-center gap-3 border-b border-white/5 bg-black/20 backdrop-blur-md shrink-0 relative z-10">
      <div className="flex items-center gap-2 shrink-0">
        <div className="text-[10px] font-semibold tracking-wider text-command-warm-white/80 uppercase">Claim Ledger</div>
        <span className="t-mono text-[8px] text-command-warm-white/35">§7</span>
      </div>
      <div className="h-6 w-px bg-white/5" />
      <div className="flex items-center gap-2 flex-1 overflow-x-auto custom-scrollbar">
        {BUCKETS.map((b) => {
          const n = stats[b.key] ?? 0;
          const dim = n === 0;
          return (
            <div
              key={b.key}
              title={`${b.state} — Symphony §7`}
              className={`flex items-center gap-2.5 h-9 pl-2.5 pr-3 rounded-lg border border-white/5 bg-black/30 transition-opacity ${dim ? 'opacity-40' : ''}`}
            >
              <b.Icon size={15} className={`${b.accent} ${b.iconPulse && !dim ? 'animate-pulse' : ''}`} />
              <div className="flex flex-col items-start leading-none">
                <span className={`t-mono text-[14px] font-bold ${b.accent}`}>{n}</span>
                <span className="text-[8.5px] text-command-warm-white/55 mt-1 font-medium tracking-wide">{b.human}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="shrink-0 flex items-center gap-3">
        {retryPending > 0 && (
          <div className="flex items-center gap-2 h-9 pl-2.5 pr-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
            <IconRetrying size={15} className="text-amber-400 animate-pulse" />
            <div className="flex flex-col items-start leading-none">
              <span className="t-mono text-[14px] font-bold text-amber-400 glow-text">{retryPending}</span>
              <span className="text-[8.5px] text-amber-300/80 mt-1 font-medium tracking-wide">Pending Retry</span>
            </div>
          </div>
        )}
        <div className="h-6 w-px bg-white/5" />
        <div className="flex flex-col items-end leading-none">
          <span className="t-mono text-[14px] font-bold text-command-warm-white">{total}</span>
          <span className="text-[8.5px] text-command-warm-white/45 mt-1 font-medium tracking-wide">total claims</span>
        </div>
      </div>
    </div>
  );
});
ClaimsStrip.displayName = 'ClaimsStrip';

export default ClaimsStrip;
