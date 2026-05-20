import { memo } from 'react';
import type { AgentRosterCard } from '../../store/useWarRoomStore';
import { AgentAvatarFallback } from '../AgentAvatarFallback';

interface StageProps {
  roster: AgentRosterCard[];
  activeSpeakerId: string | null;
}

export const Stage = memo(({ roster, activeSpeakerId }: StageProps) => {
  // Ensure we have a predictable sort order for consistent seat arrangement
  const orderedRoster = [...roster].sort((a, b) => a.id.localeCompare(b.id));

  // Limit to maximum of 9 main seats around the table
  const seats = orderedRoster.slice(0, 9);
  const totalSeats = seats.length;

  return (
    <div className="relative w-full h-[320px] bg-black/25 backdrop-blur-md rounded-xl border border-white/5 overflow-hidden flex items-center justify-center select-none">
      {/* Grid tech background */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(193,95,60,0.04),transparent_60%)] pointer-events-none" />
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.01)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.01)_1px,transparent_1px)] bg-[size:16px_16px] pointer-events-none" />

      {/* Cyber table core - virtual glowing round table */}
      <div className="relative w-36 h-36 rounded-full bg-black/40 border border-white/10 flex items-center justify-center shadow-[0_0_30px_rgba(0,0,0,0.6)]">
        {/* Core glow ring */}
        <div className="absolute inset-1.5 rounded-full border border-white/5 bg-gradient-to-tr from-command-accent/5 to-command-accent/15 animate-[spin_20s_linear_infinite]" />
        
        {/* Active speaker core pulse */}
        {activeSpeakerId ? (
          <div className="absolute inset-4 rounded-full bg-command-accent/10 border border-command-accent/30 animate-pulse flex items-center justify-center shadow-[0_0_20px_rgba(193,95,60,0.15)]">
            <span className="text-[10px] font-bold tracking-widest text-command-accent/80 uppercase animate-pulse">
              CONVENING
            </span>
          </div>
        ) : (
          <div className="absolute inset-4 rounded-full bg-white/5 border border-white/5 flex items-center justify-center">
            <span className="text-[9px] font-bold tracking-widest text-command-warm-white/20 uppercase">
              STANDBY
            </span>
          </div>
        )}
      </div>

      {/* Seating Arrangement */}
      {seats.map((agent, index) => {
        const angleDeg = (index * 360) / totalSeats - 90; // Start at 12 o'clock
        const angleRad = (angleDeg * Math.PI) / 180;
        
        // Circular coordinates
        const x = 50 + 38 * Math.cos(angleRad); // % left
        const y = 50 + 38 * Math.sin(angleRad); // % top

        const isSpeaking = activeSpeakerId === agent.id;
        const colorAccent = agent.accent_hex || '#C15F3C';
        const isLiveChair = agent.chair?.presence === 'live';

        return (
          <div
            key={agent.id}
            style={{
              position: 'absolute',
              left: `${x}%`,
              top: `${y}%`,
              transform: 'translate(-50%, -50%)',
            }}
            className="flex flex-col items-center justify-center z-10"
          >
            {/* Pulsing glow under active speaker */}
            {isSpeaking && (
              <div 
                style={{ backgroundColor: colorAccent }}
                className="absolute w-16 h-16 rounded-full opacity-35 blur-md animate-ping pointer-events-none" 
              />
            )}

            {/* Avatar block */}
            <div 
              style={{ 
                borderColor: isSpeaking ? colorAccent : 'rgba(255,255,255,0.1)',
                boxShadow: isSpeaking ? `0 0 15px ${colorAccent}40` : 'none'
              }}
              className={`w-12 h-12 rounded-full border-2 bg-black/60 relative flex items-center justify-center transition-all duration-300 ${
                isSpeaking ? 'scale-110 z-20' : 'hover:border-white/20'
              }`}
            >
              {agent.portrait_url ? (
                <img
                  src={agent.portrait_url}
                  alt={agent.name}
                  className="w-full h-full rounded-full object-cover"
                  onError={(e) => {
                    // Fallback to SVG if image fails to load
                    (e.currentTarget as HTMLImageElement).style.display = 'none';
                    const parent = e.currentTarget.parentElement;
                    if (parent) {
                      const svg = parent.querySelector('svg');
                      if (svg) svg.style.display = 'block';
                    }
                  }}
                />
              ) : null}

              {/* Renders fallback SVG next to image, hidden by default unless image triggers onError */}
              <div className={agent.portrait_url ? 'hidden' : 'block'}>
                <AgentAvatarFallback agentId={agent.id} size={44} />
              </div>

              {/* Status beacon badge */}
              <span 
                className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-black ${
                  isLiveChair 
                    ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)] animate-pulse'
                    : agent.status === 'dispatching'
                      ? 'bg-amber-500 animate-pulse'
                      : 'bg-zinc-600'
                }`}
                title={`Chair Status: ${isLiveChair ? 'Live' : 'Standby'}`}
              />
            </div>

            {/* Label name tags */}
            <div className="mt-1.5 px-2 py-0.5 rounded bg-black/60 border border-white/5 backdrop-blur-sm flex flex-col items-center max-w-[80px]">
              <span className="text-[9.5px] font-bold text-command-warm-white tracking-wide truncate w-full text-center">
                {agent.name.replace(/^nyx-/, '')}
              </span>
              <span className="text-[7px] text-command-warm-white/45 tracking-widest uppercase truncate max-w-full">
                {agent.status}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
});

Stage.displayName = 'Stage';
export default Stage;
