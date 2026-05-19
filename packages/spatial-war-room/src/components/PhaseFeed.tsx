import { memo } from 'react';
import type { PhaseEvent } from '../store/useWarRoomStore';

interface PhaseFeedProps {
  events: PhaseEvent[];
}

const PHASE_COLOR: Record<string, string> = {
  PreparingContext: 'text-command-warm-white/60',
  DispatchToArchitect: 'text-command-accent',
  ArchitectStreaming: 'text-command-accent glow-text',
  DispatchToOperator: 'text-amber-400',
  OperatorExecuting: 'text-amber-400',
  DispatchToVerifier: 'text-cyan-400',
  VerifierAuditing: 'text-cyan-400',
  IssuingReceipt: 'text-emerald-400',
  Succeeded: 'text-emerald-400 glow-text',
  Failed: 'text-red-400',
  Stalled: 'text-red-400',
};

const Row = memo(({ evt }: { evt: PhaseEvent }) => {
  const color = PHASE_COLOR[evt.phase] || 'text-command-warm-white/70';
  const time = new Date(evt.timestamp).toISOString().split('T')[1].split('.')[0];
  return (
    <div className="flex items-center gap-3 px-3 h-7 border-r border-white/5 shrink-0">
      <span className="t-mono text-[9px] text-command-warm-white/40">{time}</span>
      {evt.routedAgent && (
        <span className="t-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 bg-command-accent/10 text-command-accent/90 rounded">
          {evt.routedAgent}
        </span>
      )}
      <span className={`t-mono text-[10px] font-bold ${color}`}>{evt.phase}</span>
      <span className="t-mono text-[8px] text-command-warm-white/30 font-mono">
        cycle:{evt.cycleId.slice(0, 8)}
      </span>
      {evt.note && (
        <span className="t-mono text-[9px] text-command-warm-white/50 italic truncate max-w-[280px]">
          {evt.note}
        </span>
      )}
    </div>
  );
});
Row.displayName = 'PhaseFeed.Row';

export const PhaseFeed = memo(({ events }: PhaseFeedProps) => (
  <footer className="h-9 border-t border-white/5 bg-black/40 backdrop-blur-xl flex items-stretch relative z-20">
    <div className="px-4 flex items-center gap-2 border-r border-white/5 shrink-0">
      <div className="w-1.5 h-1.5 rounded-full bg-command-accent animate-pulse shadow-[0_0_8px_rgba(193,95,60,0.6)]" />
      <span className="t-eyebrow">PHASE_FEED</span>
    </div>
    <div className="flex-1 overflow-x-auto overflow-y-hidden custom-scrollbar flex items-stretch">
      {events.length === 0 ? (
        <div className="px-3 flex items-center t-mono text-[9px] text-command-warm-white/30 italic">
          awaiting cycle events…
        </div>
      ) : (
        events.map((evt, i) => <Row key={`${evt.cycleId}-${evt.timestamp}-${i}`} evt={evt} />)
      )}
    </div>
  </footer>
));
PhaseFeed.displayName = 'PhaseFeed';

export default PhaseFeed;
