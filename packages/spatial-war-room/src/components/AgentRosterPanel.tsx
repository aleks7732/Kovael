import { memo, useEffect, useState } from 'react';
import type { AgentRosterCard, HardwareTelemetry, RateLimitSnapshot } from '../store/useWarRoomStore';
import { AgentAvatarFallback } from './AgentAvatarFallback';

interface AgentRosterPanelProps {
  roster: AgentRosterCard[];
  hardware: HardwareTelemetry | null;
  rateLimits: Record<string, RateLimitSnapshot>;
  interAgentChatEnabled: boolean;
  interAgentChatMode: 'technical' | 'interests';
  interAgentMessages: Array<{
    id: string;
    timestamp: number;
    senderId: string;
    senderName: string;
    recipientId: string;
    recipientName: string;
    content: string;
  }>;
  onToggleInterAgentChat: (enabled: boolean) => void;
  onChangeInterAgentChatMode: (mode: 'technical' | 'interests') => void;
}

interface StatusStyle { dot: string; text: string; label: string }
const STATUS_STYLE: Record<AgentRosterCard['status'], StatusStyle> = {
  online:      { dot: 'bg-emerald-500 shadow-[0_0_6px_rgba(52,211,153,0.6)]',     text: 'text-emerald-300',     label: 'Online' },
  dispatching: { dot: 'bg-command-accent shadow-[0_0_6px_rgba(193,95,60,0.6)] animate-pulse', text: 'text-command-accent', label: 'Dispatching' },
  idle:        { dot: 'bg-white/30',                                              text: 'text-command-warm-white/55', label: 'Idle' },
  offline:     { dot: 'bg-red-500',                                               text: 'text-red-300',         label: 'Offline' },
};

const TRUST_LABEL: Record<number, string> = {
  1: 'Tier 1 · Sovereign',
  2: 'Tier 2 · Elevated',
  3: 'Tier 3 · Local',
};

function formatBeaconAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

const ChairBeaconPill = memo(({ card }: { card: AgentRosterCard }) => {
  // Tick once per second so "last seen Ns ago" stays accurate without
  // requiring a global timer in the store.
  const [, force] = useState(0);
  useEffect(() => {
    if (!card.chair) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [card.chair]);

  if (!card.chair) {
    return (
      <span
        className="t-mono text-[8px] font-semibold tracking-wider px-1.5 py-0.5 rounded bg-white/[0.04] text-command-warm-white/40 border border-white/5"
        title="No live beacon — agent process is not running"
      >
        UNCLAIMED
      </span>
    );
  }
  const age = Date.now() - card.chair.lastBeaconAt;
  const isLive = card.chair.presence === 'live';
  const isStale = card.chair.presence === 'stale';
  const tone = isLive
    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
    : isStale
      ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
      : 'bg-red-500/15 text-red-300 border-red-500/30';
  const dot = isLive
    ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)] animate-pulse'
    : isStale
      ? 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)]'
      : 'bg-red-400';
  return (
    <span
      className={`flex items-center gap-1 t-mono text-[8px] font-semibold tracking-wider px-1.5 py-0.5 rounded border ${tone}`}
      title={`Chair Beacon · last seen ${formatBeaconAge(age)} · session ${card.chair.sessionId.slice(0, 8)}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      LIVE · {formatBeaconAge(age)}
    </span>
  );
});
ChairBeaconPill.displayName = 'AgentRosterPanel.ChairBeaconPill';

const AgentCard = memo(({ card, rate }: { card: AgentRosterCard; rate?: RateLimitSnapshot }) => {
  const status = STATUS_STYLE[card.status];
  const hasLiveBeacon = card.chair?.presence === 'live';
  const [imgError, setImgError] = useState(false);

  return (
  <div 
    className={`glass-panel p-3 transition-all duration-300 relative overflow-hidden ${
      hasLiveBeacon ? 'ring-1 ring-emerald-500/15' : ''
    }`}
    style={card.accent_hex && hasLiveBeacon ? { borderLeft: `3px solid ${card.accent_hex}` } : undefined}
  >
    <div className="flex items-start gap-3 mb-2">
      {/* 36x36 Avatar */}
      <div className="shrink-0 w-9 h-9 relative">
        {!imgError && card.portrait_url ? (
          <img
            src={card.portrait_url}
            alt={`${card.name} avatar`}
            className="w-9 h-9 rounded-full object-cover border border-white/10 shadow-md"
            onError={() => setImgError(true)}
          />
        ) : (
          <AgentAvatarFallback agentId={card.id} size={36} />
        )}
        {/* Status indicator sitting on the avatar */}
        <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#121212] shrink-0 ${status.dot}`} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="font-display font-bold text-[14px] text-command-warm-white leading-none truncate">
            {card.name}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <ChairBeaconPill card={card} />
            {rate && (
              <span
                className={`t-mono text-[8.5px] font-semibold tracking-wide px-1.5 py-0.5 rounded tabular-nums ${
                  rate.blocked
                    ? 'bg-red-500/15 text-red-300'
                    : rate.inWindow / rate.capacity > 0.7
                      ? 'bg-amber-500/15 text-amber-300'
                      : 'bg-emerald-500/10 text-emerald-300/80'
                }`}
                title={`Rate-limit: ${rate.inWindow} of ${rate.capacity} dispatches in last ${Math.round(rate.windowMs / 1000)}s`}
              >
                {rate.inWindow}/{rate.capacity}
              </span>
            )}
            {card.trust_tier !== undefined && (
              <div className="t-mono text-[9px] text-command-accent/85 font-bold tracking-wider" title={TRUST_LABEL[card.trust_tier] ?? `Trust tier ${card.trust_tier}`}>
                T{card.trust_tier}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between mt-1">
          <span className={`text-[10.5px] font-semibold ${status.text}`}>{status.label}</span>
          <span className="t-mono text-[9px] text-command-warm-white/45 truncate ml-2">{card.provider}</span>
        </div>
      </div>
    </div>

    {card.description && (
      <div className="text-[10px] text-command-warm-white/65 leading-snug mb-2 pl-[48px]">{card.description}</div>
    )}
    {card.mcp_capabilities && card.mcp_capabilities.length > 0 && (
      <div className="flex flex-wrap gap-1 mb-2 pl-[48px]">
        {card.mcp_capabilities.slice(0, 6).map((cap) => (
          <span
            key={cap}
            className="t-mono text-[8px] uppercase tracking-wider px-1.5 py-0.5 bg-command-accent/10 text-command-accent/90 rounded"
          >
            {cap}
          </span>
        ))}
      </div>
    )}
    <div className="flex items-center justify-between pt-1.5 border-t border-white/5 pl-[48px]">
      {card.vram_requirements && (
        <span className="t-mono text-[9px] text-command-warm-white/55">VRAM · {card.vram_requirements}</span>
      )}
      {card.trust_tier !== undefined && TRUST_LABEL[card.trust_tier] && (
        <span className="text-[8.5px] font-medium text-command-warm-white/50 tracking-wide">{TRUST_LABEL[card.trust_tier]}</span>
      )}
    </div>
  </div>
  );
});
AgentCard.displayName = 'AgentRosterPanel.Card';

const VramGauge = memo(({ hardware }: { hardware: HardwareTelemetry | null }) => {
  if (!hardware || hardware.status !== 'ok' || hardware.totalMb === 0) {
    return (
      <div className="glass-panel p-3">
        <div className="t-eyebrow mb-2">HARDWARE_MONITOR</div>
        <div className="t-mono text-[10px] text-white/40 italic text-center py-2">
          {hardware?.status === 'unavailable' ? 'nvidia-smi unavailable' : 'awaiting telemetry…'}
        </div>
      </div>
    );
  }

  const freePct = Math.min(100, Math.round((hardware.freeMb / hardware.totalMb) * 100));
  const usedPct = 100 - freePct;
  const utilPct = hardware.utilizationPct;

  const freeBar =
    hardware.freeMb >= 8192 ? 'bg-emerald-500' :
    hardware.freeMb >= 4096 ? 'bg-amber-500' : 'bg-red-500';

  return (
    <div className="glass-panel p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="t-eyebrow">HARDWARE_MONITOR</div>
        <div className="t-mono text-[8px] text-command-warm-white/50">{hardware.devices}× GPU</div>
      </div>

      <div>
        <div className="flex items-baseline justify-between mb-1">
          <span className="t-mono text-[9px] text-command-warm-white/70 uppercase tracking-wider">VRAM Free</span>
          <span className="t-mono text-[11px] font-bold text-command-warm-white">
            {(hardware.freeMb / 1024).toFixed(1)} / {(hardware.totalMb / 1024).toFixed(0)} GB
          </span>
        </div>
        <div className="h-1.5 w-full bg-black/40 rounded-full overflow-hidden">
          <div className={`h-full ${freeBar} transition-all duration-500`} style={{ width: `${freePct}%` }} />
        </div>
        <div className="flex justify-between t-mono text-[8px] text-command-warm-white/40 mt-0.5">
          <span>{freePct}% free</span>
          <span>{usedPct}% used</span>
        </div>
      </div>

      <div>
        <div className="flex items-baseline justify-between mb-1">
          <span className="t-mono text-[9px] text-command-warm-white/70 uppercase tracking-wider">GPU Utilization</span>
          <span className="t-mono text-[11px] font-bold text-command-accent glow-text">{utilPct}%</span>
        </div>
        <div className="h-1.5 w-full bg-black/40 rounded-full overflow-hidden">
          <div className="h-full bg-command-accent transition-all duration-500" style={{ width: `${utilPct}%` }} />
        </div>
      </div>

      <div className="pt-2 border-t border-white/5 flex items-center justify-between">
        <span className="t-eyebrow !text-[7px]">SHAEV_GATE</span>
        <span className={`t-mono text-[9px] font-bold ${hardware.freeMb >= 8192 ? 'text-emerald-400' : 'text-amber-400'}`}>
          {hardware.freeMb >= 8192 ? 'AUTHORIZED' : 'GATED → NYX-CLI'}
        </span>
      </div>
    </div>
  );
});
VramGauge.displayName = 'AgentRosterPanel.VramGauge';

export const AgentRosterPanel = memo(({
  roster,
  hardware,
  rateLimits,
  interAgentChatEnabled,
  interAgentChatMode,
  interAgentMessages,
  onToggleInterAgentChat,
  onChangeInterAgentChatMode,
}: AgentRosterPanelProps) => (
  <aside className="h-full w-[300px] shrink-0 border-l border-white/5 bg-black/20 backdrop-blur-xl flex flex-col">
    <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
      <div>
        <div className="t-eyebrow">AGENT_ROSTER</div>
        <div className="font-display font-bold text-[14px] text-command-warm-white leading-tight mt-0.5">
          Active Mesh
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 bg-white/[0.03] border border-white/5 rounded px-1.5 py-0.5">
          <span className="t-mono text-[7px] text-command-warm-white/50 tracking-wider">BANTER</span>
          <button
            onClick={() => onToggleInterAgentChat(!interAgentChatEnabled)}
            className={`relative w-7 h-4 rounded-full p-0.5 transition-colors duration-300 border border-white/10 ${
              interAgentChatEnabled ? 'bg-command-accent shadow-[0_0_8px_rgba(193,95,60,0.5)]' : 'bg-black/40'
            }`}
          >
            <div
              className={`w-2.5 h-2.5 rounded-full bg-white transition-transform duration-300 ${
                interAgentChatEnabled ? 'translate-x-3' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
        <div className="t-mono text-[9px] text-command-accent font-bold px-1.5 py-0.5 bg-command-accent/10 rounded">
          {roster.length}
        </div>
      </div>
    </div>

    <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-2">
      {roster.length === 0 ? (
        <div className="t-mono text-[10px] text-white/30 italic text-center py-6 border border-dashed border-white/5 rounded-lg">
          NO_AGENTS_REGISTERED
        </div>
      ) : (
        roster.map((card) => <AgentCard key={card.id} card={card} rate={rateLimits[card.id]} />)
      )}
      <VramGauge hardware={hardware} />
    </div>

    {interAgentChatEnabled && (
      <div className="border-t border-white/5 h-[340px] flex flex-col bg-black/30 backdrop-blur-md">
        <div className="px-3 py-1.5 border-b border-white/5 bg-white/[0.02] flex items-center justify-between">
          <span className="t-eyebrow flex items-center gap-1.5 !text-[8px]">
            <span className="w-1.5 h-1.5 rounded-full bg-command-accent animate-pulse shadow-[0_0_6px_rgba(193,95,60,0.7)]" />
            SOVEREIGN_BANTER_STREAM
          </span>
          <div className="flex items-center gap-1 bg-white/[0.03] border border-white/5 rounded p-0.5">
            <button
              onClick={() => onChangeInterAgentChatMode('technical')}
              className={`t-mono text-[7px] px-1.5 py-0.5 rounded transition-all duration-300 ${
                interAgentChatMode === 'technical'
                  ? 'bg-command-accent/20 text-command-accent font-bold'
                  : 'text-command-warm-white/40 hover:text-command-warm-white/70'
              }`}
            >
              TECHNICAL
            </button>
            <button
              onClick={() => onChangeInterAgentChatMode('interests')}
              className={`t-mono text-[7px] px-1.5 py-0.5 rounded transition-all duration-300 ${
                interAgentChatMode === 'interests'
                  ? 'bg-command-accent/20 text-command-accent font-bold'
                  : 'text-command-warm-white/40 hover:text-command-warm-white/70'
              }`}
            >
              INTERESTS
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2.5 custom-scrollbar flex flex-col-reverse">
          {interAgentMessages.length === 0 ? (
            <div className="t-mono text-[9px] text-white/30 italic text-center py-6">
              awaiting dialogue signal…
            </div>
          ) : (
            [...interAgentMessages].reverse().map((msg) => {
              const colors: Record<string, { dot: string; text: string; bg: string; border: string }> = {
                'nyx-antigravity': {
                  dot: 'bg-command-accent shadow-[0_0_5px_rgba(193,95,60,0.6)]',
                  text: 'text-command-accent',
                  bg: 'bg-command-accent/5',
                  border: 'border-command-accent/20'
                },
                'nyx-cli': {
                  dot: 'bg-cyan-500 shadow-[0_0_5px_rgba(6,182,212,0.6)]',
                  text: 'text-cyan-400',
                  bg: 'bg-cyan-500/5',
                  border: 'border-cyan-500/20'
                },
                'nyx-openclaw': {
                  dot: 'bg-purple-500 shadow-[0_0_5px_rgba(168,85,247,0.6)]',
                  text: 'text-purple-400',
                  bg: 'bg-purple-500/5',
                  border: 'border-purple-500/20'
                },
                'shaev': {
                  dot: 'bg-emerald-500 shadow-[0_0_5px_rgba(16,185,129,0.6)]',
                  text: 'text-emerald-400',
                  bg: 'bg-emerald-500/5',
                  border: 'border-emerald-500/20'
                }
              };
              const c = colors[msg.senderId] || {
                dot: 'bg-white/40',
                text: 'text-white/70',
                bg: 'bg-white/5',
                border: 'border-white/10'
              };
              const time = new Date(msg.timestamp).toISOString().split('T')[1].split('.')[0];
              return (
                <div key={msg.id} className={`p-2 rounded-lg border ${c.bg} ${c.border} transition-all duration-300 hover:border-white/10`}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1.5">
                      <span className={`w-1 h-1 rounded-full ${c.dot}`} />
                      <span className={`font-display font-bold text-[9px] uppercase tracking-wider ${c.text}`}>{msg.senderName}</span>
                      <span className="text-white/25 text-[8px]">→</span>
                      <span className="t-mono text-[8px] text-white/40 uppercase">{msg.recipientName.split('-')[1] || msg.recipientName}</span>
                    </div>
                    <span className="t-mono text-[8px] text-white/30">{time}</span>
                  </div>
                  <div className="text-[10px] text-white/80 leading-relaxed font-sans">{msg.content}</div>
                </div>
              );
            })
          )}
        </div>
      </div>
    )}
  </aside>
));
AgentRosterPanel.displayName = 'AgentRosterPanel';

export default AgentRosterPanel;
