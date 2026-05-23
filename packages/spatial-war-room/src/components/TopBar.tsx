import { memo, useEffect, useState, useMemo } from 'react';
import { MissionConsole } from './MissionConsole';
import { useWarRoomStore, type TokenTotals } from '../store/useWarRoomStore.js';

interface TopBarProps {
  meshStatus: 'live' | 'syncing' | 'offline';
  connectedClients?: number;
  receiptsIssued: number;
  activeAgents: number;
  nodeCount: number;
  tokenTotals: TokenTotals;
  onInjectMission: (goal: string) => void;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

interface StatusStyle {
  dot: string;
  pill: string;
  textTone: string;
  technical: string;
  human: string;
  pulse: boolean;
}

const STATUS_STYLES: Record<TopBarProps['meshStatus'], StatusStyle> = {
  live:    { dot: 'bg-emerald-500 shadow-[0_0_10px_rgba(52,211,153,0.6)]', pill: 'border-emerald-500/30 bg-emerald-500/5', textTone: 'text-emerald-300', technical: 'LIVE',    human: 'Mesh healthy',           pulse: false },
  syncing: { dot: 'bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.6)]',   pill: 'border-amber-500/30 bg-amber-500/5',     textTone: 'text-amber-300',  technical: 'SYNCING', human: 'Syncing nodes',          pulse: true  },
  offline: { dot: 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.6)]',      pill: 'border-red-500/30 bg-red-500/5',         textTone: 'text-red-300',    technical: 'OFFLINE', human: 'Disconnected — retrying', pulse: true  },
};

const Stat = memo(({ label, value, hint, accent = false }: { label: string; value: string | number; hint: string; accent?: boolean }) => (
  <div className="flex flex-col items-end leading-none" title={hint}>
    <div className={`t-mono text-[14px] font-bold ${accent ? 'text-command-accent glow-text' : 'text-command-warm-white'}`}>
      {value}
    </div>
    <div className="text-[8.5px] mt-1 text-command-warm-white/55 font-medium tracking-wide uppercase">{label}</div>
  </div>
));
Stat.displayName = 'TopBar.Stat';

export const TopBar = memo(({ meshStatus, connectedClients = 0, receiptsIssued, activeAgents, nodeCount, tokenTotals, onInjectMission }: TopBarProps) => {
  const [now, setNow] = useState(() => new Date());
  const activeTab = useWarRoomStore((s) => s.activeTab);
  const setActiveTab = useWarRoomStore((s) => s.setActiveTab);
  const hookEvents = useWarRoomStore((s) => s.hookEvents);
  const claimStats = useWarRoomStore((s) => s.claimStats);
  const retryPendingCount = useWarRoomStore((s) => s.retryPendingCount);

  const traceHealth = useMemo(() => {
    if (hookEvents.length === 0) return 100;
    const failures = hookEvents.filter(e => !e.success).length;
    return Math.round(((hookEvents.length - failures) / hookEvents.length) * 100);
  }, [hookEvents]);

  const queuePressure = useMemo(() => {
    const running = claimStats.Running ?? 0;
    const retry = claimStats.RetryQueued ?? 0;
    return running + retry + retryPendingCount;
  }, [claimStats, retryPendingCount]);

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
            <span className="text-[8.5px] mt-1 text-command-warm-white/55 font-medium tracking-wide uppercase">Sovereign Agentic Mesh</span>
          </div>
        </div>
        <div className="h-7 w-px bg-white/10" />
        <div
          className={`flex items-center gap-2 h-9 pl-2.5 pr-3 rounded-lg border ${status.pill}`}
          title={`Mesh status: ${status.technical}`}
        >
          <div className={`w-2 h-2 rounded-full ${status.dot} ${status.pulse ? 'animate-pulse' : ''}`} />
          <div className="flex flex-col items-start leading-none">
            <span className={`text-[12px] font-semibold ${status.textTone} leading-none`}>{status.human}</span>
            <span className="text-[8.5px] mt-1 text-command-warm-white/45 font-medium tracking-wide uppercase">{status.technical}</span>
          </div>
        </div>
        <div className="h-7 w-px bg-white/10" />
        <div className="flex items-center gap-1 bg-black/40 p-1 rounded-lg border border-white/5 relative z-30">
          <button
            onClick={() => setActiveTab('canvas')}
            className={`px-3 py-1 text-[10.5px] rounded font-bold tracking-wider uppercase transition-all select-none cursor-pointer ${
              activeTab === 'canvas'
                ? 'bg-command-accent/20 border border-command-accent/30 text-command-warm-white shadow-[0_0_8px_rgba(193,95,60,0.3)]'
                : 'text-command-warm-white/50 hover:text-command-warm-white/80 border border-transparent'
            }`}
          >
            Canvas
          </button>
          <button
            onClick={() => setActiveTab('theater')}
            className={`px-3 py-1 text-[10.5px] rounded font-bold tracking-wider uppercase transition-all select-none cursor-pointer ${
              activeTab === 'theater'
                ? 'bg-command-accent/20 border border-command-accent/30 text-command-warm-white shadow-[0_0_8px_rgba(193,95,60,0.3)]'
                : 'text-command-warm-white/50 hover:text-command-warm-white/80 border border-transparent'
            }`}
          >
            Theater
          </button>
        </div>
      </div>

      <div className="flex-1 flex justify-center px-6">
        <MissionConsole onInject={onInjectMission} disabled={meshStatus === 'offline'} />
      </div>

      <div className="flex items-center gap-7">
        <Stat label="Clients" value={connectedClients} hint="WebSocket clients currently connected to the orchestrator" />
        <Stat label="Agents"  value={activeAgents}     hint="Distinct agent identities registered on the mesh" />
        <Stat label="Nodes"   value={nodeCount}        hint="ReactFlow nodes rendered in the canvas" />
        <Stat label="Receipts" value={receiptsIssued}  hint="ZTNP verification receipts issued since boot" accent />
        <Stat label="Tokens"  value={formatTokens(tokenTotals.total)} hint="Cumulative input+output tokens across all Triad cycles" />
        <div className="h-7 w-px bg-white/10" />
        <Stat label="Trace Health" value={`${traceHealth}%`} hint="OTel Trace execution health (based on hook success rate)" accent={traceHealth < 100} />
        <Stat label="Queue Pressure" value={queuePressure} hint="Mesh dispatch queue pressure (active dispatches + retries)" accent={queuePressure > 0} />
        <div className="h-7 w-px bg-white/10" />
        <Stat label="UTC"     value={time}             hint="Server time, ISO-8601" />
      </div>
    </header>
  );
});
TopBar.displayName = 'TopBar';

export default TopBar;
