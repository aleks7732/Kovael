import { memo } from 'react';

interface StoppingCardProps {
  criterion: {
    agentId: string;
    reason: string;
    confidence: number;
  } | null;
}

export const StoppingCard = memo(({ criterion }: StoppingCardProps) => {
  if (!criterion) return null;

  const isAdaptiveStability = criterion.reason.startsWith('adaptive_stability_reached');
  const cleanReason = criterion.reason
    .replace('adaptive_stability_reached:', 'Adaptive Stability Met: ')
    .replace('hard_cap_reached:', 'Hard Cap Exceeded: ');

  return (
    <div className="w-full bg-emerald-950/20 border border-emerald-500/30 shadow-[0_0_15px_rgba(16,185,129,0.05)] rounded-xl p-4.5 backdrop-blur-md relative select-none animate-[fadeIn_0.4s_ease-out]">
      {/* Decorative pulse glow */}
      <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-emerald-500/2 to-transparent pointer-events-none" />

      <div className="flex gap-3">
        {/* Verification Icon */}
        <div className="w-9 h-9 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center flex-shrink-0 text-emerald-400">
          <svg className="w-5 h-5 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
        </div>

        {/* Content details */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h4 className="text-[12px] font-extrabold tracking-wider text-emerald-300 uppercase leading-none">
              VERIFIER CONSENSUS REACHED
            </h4>
            <div className="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-[9px] font-mono text-emerald-400">
              CONFIDENCE: {(criterion.confidence * 100).toFixed(0)}%
            </div>
          </div>

          <p className="text-[11.5px] mt-1.5 text-emerald-100/70 font-medium leading-relaxed">
            The round-table debate has successfully converged. Verifier{' '}
            <span className="text-emerald-300 font-bold">@{criterion.agentId}</span> evaluated the proposal
            transcripts and recorded a stable stopping condition.
          </p>

          {/* Technical convergence metadata logs */}
          <div className="mt-3 flex items-center gap-4 text-[9.5px] font-mono text-emerald-400/50">
            <div className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/50" />
              <span>METRIC: {isAdaptiveStability ? 'ADAPTIVE STABILITY (arXiv 2510.12697)' : 'ROUND TIMEOUT'}</span>
            </div>
            <div>•</div>
            <div className="truncate max-w-[250px]" title={criterion.reason}>
              RATIONALE: {cleanReason}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

StoppingCard.displayName = 'StoppingCard';
export default StoppingCard;
