import { memo, useEffect, useState } from 'react';

interface TopBarProps {
  meshStatus: 'live' | 'syncing' | 'offline';
  connectedClients?: number;
  receiptsIssued: number;
  activeAgents: number;
  nodeCount: number;
}

const STATUS_STYLES: Record<TopBarProps['meshStatus'], { dot: string; label: string }> = {
  live: { dot: 'bg-emerald-500 shadow-[0_0_10px_rgba(52,211,153,0.6)]', label: 'LIVE' },
  syncing: { dot: 'bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.6)] animate-pulse', label: 'SYNCING' },
  offline: { dot: 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.6)]', label: 'OFFLINE' },
};

const Stat = memo(({ label, value, accent = false }: { label: string; value: string | number; accent?: boolean }) => (
  <div className="flex flex-col items-end">
    <div className="t-eyebrow !text-[7px]">{label}</div>
    <div className={`t-mono text-[13px] font-bold leading-none ${accent ? 'text-command-accent glow-text' : 'text-command-warm-white'}`}>
      {value}
    </div>
  </div>
));
Stat.displayName = 'TopBar.Stat';

export const TopBar = memo(({ meshStatus, connectedClients = 0, receiptsIssued, activeAgents, nodeCount }: TopBarProps) => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const status = STATUS_STYLES[meshStatus];
  const time = now.toISOString().split('T')[1].split('.')[0];

  return (
    <header className="h-14 px-5 flex items-center justify-between border-b border-white/5 bg-black/30 backdrop-blur-xl relative z-20">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-2 h-2 rotate-45 bg-command-accent shadow-[0_0_12px_rgba(193,95,60,0.7)]" />
          <div className="flex flex-col leading-none">
            <span className="font-display font-bold text-[18px] tracking-tight text-command-warm-white">KOVAEL</span>
            <span className="t-eyebrow !text-[7px] mt-0.5">SOVEREIGN AGENTIC MESH</span>
          </div>
        </div>
        <div className="h-7 w-px bg-white/10" />
        <div className="flex items-center gap-2">
          <div className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
          <span className="t-mono text-[10px] tracking-widest text-command-warm-white/70 uppercase">{status.label}</span>
        </div>
      </div>

      <div className="flex items-center gap-7">
        <Stat label="CLIENTS" value={connectedClients} />
        <Stat label="AGENTS" value={activeAgents} />
        <Stat label="NODES" value={nodeCount} />
        <Stat label="RECEIPTS" value={receiptsIssued} accent />
        <div className="h-7 w-px bg-white/10" />
        <Stat label="UTC" value={time} />
      </div>
    </header>
  );
});
TopBar.displayName = 'TopBar';

export default TopBar;
