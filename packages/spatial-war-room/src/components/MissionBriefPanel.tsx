import { memo, useEffect, useState } from 'react';
import { ANXDisplay } from './ANXDisplay';
import type { ANXBriefing, PhaseEvent } from '../store/useWarRoomStore';

interface MissionBriefPanelProps {
  briefings: ANXBriefing[];
  phaseEvents: PhaseEvent[];
}

const TERMINAL_PHASES = new Set(['Succeeded', 'Failed', 'Stalled']);

const PHASE_HUMAN: Record<string, string> = {
  PreparingContext: 'Preparing context',
  DispatchToArchitect: 'Dispatching to Architect',
  ArchitectStreaming: 'Architect working',
  DispatchToOperator: 'Dispatching to Operator',
  OperatorExecuting: 'Operator running',
  DispatchToVerifier: 'Dispatching to Verifier',
  VerifierAuditing: 'Verifying',
  IssuingReceipt: 'Issuing receipt',
  Succeeded: 'Succeeded',
  Failed: 'Failed',
  Stalled: 'Stalled',
};

interface ActiveMission {
  cycleId: string;
  agent?: string;
  phase: string;
  startedAt: number;
  latestAt: number;
  isComplete: boolean;
  isFailed: boolean;
}

function deriveActiveMission(phaseEvents: PhaseEvent[]): ActiveMission | null {
  if (phaseEvents.length === 0) return null;
  // phaseEvents arrives sorted newest-first. Group by cycle to find the
  // freshest cycle, then pick its current phase.
  const byCycle = new Map<string, PhaseEvent[]>();
  for (const e of phaseEvents) {
    const list = byCycle.get(e.cycleId) ?? [];
    list.push(e);
    byCycle.set(e.cycleId, list);
  }
  let bestCycle: string | null = null;
  let bestTs = -Infinity;
  for (const [cycleId, events] of byCycle) {
    const latest = Math.max(...events.map(e => e.timestamp));
    if (latest > bestTs) { bestTs = latest; bestCycle = cycleId; }
  }
  if (!bestCycle) return null;
  const cycleEvents = byCycle.get(bestCycle)!.slice().sort((a, b) => a.timestamp - b.timestamp);
  const latest = cycleEvents[cycleEvents.length - 1];
  const first = cycleEvents[0];
  return {
    cycleId: bestCycle,
    agent: cycleEvents.find(e => e.routedAgent)?.routedAgent,
    phase: latest.phase,
    startedAt: first.timestamp,
    latestAt: latest.timestamp,
    isComplete: TERMINAL_PHASES.has(latest.phase),
    isFailed: latest.phase === 'Failed' || latest.phase === 'Stalled',
  };
}

function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

const ActiveMissionCard = memo(({ mission }: { mission: ActiveMission }) => {
  // Tick the age display every second so it stays live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (mission.isComplete) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [mission.isComplete]);

  const elapsedMs = (mission.isComplete ? mission.latestAt : now) - mission.startedAt;
  const tone = mission.isFailed
    ? { border: 'border-red-500/35',     pillBg: 'bg-red-500/10',     accent: 'text-red-300',     dot: 'bg-red-500' }
    : mission.isComplete
    ? { border: 'border-emerald-500/35', pillBg: 'bg-emerald-500/10', accent: 'text-emerald-300', dot: 'bg-emerald-500' }
    : { border: 'border-command-accent/35', pillBg: 'bg-command-accent/10', accent: 'text-command-accent', dot: 'bg-command-accent animate-pulse' };

  const phaseHuman = PHASE_HUMAN[mission.phase] ?? mission.phase;
  const verdict = mission.isFailed ? 'Last mission failed' : mission.isComplete ? 'Last mission complete' : 'Mission in flight';

  return (
    <div className={`glass-panel border ${tone.border} p-4 space-y-3`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${tone.dot} shadow-[0_0_8px_currentColor]`} />
          <span className="text-[10px] font-semibold tracking-wider text-command-warm-white/80 uppercase">
            {verdict}
          </span>
        </div>
        <span className={`t-mono text-[10px] px-2 py-0.5 rounded ${tone.pillBg} ${tone.accent} tabular-nums`}>
          {formatAge(elapsedMs)}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[8.5px] text-command-warm-white/55 font-medium uppercase tracking-wide">Phase</span>
          <span className={`text-[13px] font-semibold ${tone.accent} text-right`}>{phaseHuman}</span>
        </div>
        {mission.agent && (
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[8.5px] text-command-warm-white/55 font-medium uppercase tracking-wide">Routed to</span>
            <span className="t-mono text-[11px] text-command-warm-white/90">{mission.agent}</span>
          </div>
        )}
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[8.5px] text-command-warm-white/55 font-medium uppercase tracking-wide">Cycle</span>
          <span className="t-mono text-[10px] text-command-warm-white/55 tabular-nums">{mission.cycleId.slice(0, 12)}</span>
        </div>
      </div>
    </div>
  );
});
ActiveMissionCard.displayName = 'MissionBriefPanel.ActiveMissionCard';

const EMPTY_BRIEF_TEXT = 'No mission briefing pinned yet — drop an ANX SOP and it lands here.';

export const MissionBriefPanel = memo(({ briefings, phaseEvents }: MissionBriefPanelProps) => {
  const current = briefings[0];
  const archive = briefings.slice(1, 5);
  const activeMission = deriveActiveMission(phaseEvents);

  return (
    <aside className="h-full w-[340px] shrink-0 border-r border-white/5 bg-black/20 backdrop-blur-xl flex flex-col">
      <div className="px-4 py-3 border-b border-white/5">
        <div className="text-[10px] font-semibold tracking-wider text-command-warm-white/80 uppercase">Mission Brief</div>
        <div className="font-display font-bold text-[14px] text-command-warm-white leading-tight mt-0.5">
          What's happening
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">
        {activeMission ? (
          <ActiveMissionCard mission={activeMission} />
        ) : (
          <div className="glass-panel p-4 text-center">
            <div className="text-[10px] font-semibold tracking-wider text-command-warm-white/60 uppercase mb-1">No active mission</div>
            <div className="text-[11px] text-command-warm-white/40 italic">Inject a goal from the top bar to begin.</div>
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold tracking-wider text-command-warm-white/70 uppercase">Pinned manifest</span>
            <span className="t-mono text-[9px] text-command-accent font-bold px-1.5 py-0.5 bg-command-accent/10 rounded tabular-nums">
              {briefings.length}
            </span>
          </div>

          {current ? (
            <>
              <ANXDisplay raw={current.raw} />
              {archive.length > 0 && (
                <div className="pt-2 mt-3 border-t border-white/5">
                  <div className="text-[8.5px] font-semibold tracking-wider text-command-warm-white/45 uppercase mb-2">Recent</div>
                  <div className="space-y-1">
                    {archive.map((b) => (
                      <div key={b.id} className="flex items-center justify-between t-mono text-[10px] text-command-warm-white/50 tabular-nums">
                        <span className="truncate">{b.id}</span>
                        <span className="opacity-50 shrink-0 ml-2">
                          {new Date(b.receivedAt).toISOString().split('T')[1].split('.')[0]}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="glass-panel p-3">
              <div className="text-[11px] text-command-warm-white/45 italic leading-relaxed">
                {EMPTY_BRIEF_TEXT}
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
});
MissionBriefPanel.displayName = 'MissionBriefPanel';

export default MissionBriefPanel;
