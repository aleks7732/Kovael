import { memo } from 'react';
import { ANXDisplay } from './ANXDisplay';
import type { ANXBriefing } from '../store/useWarRoomStore';

interface MissionBriefPanelProps {
  briefings: ANXBriefing[];
}

const EMPTY_GUIDE = `
Drop an ANX SOP into the mesh to populate this panel.
The orchestrator parses three canonical tags:

  <mission_manifest>  — objective, scope, constraints, priority
  <provenance>        — creator, lineage, version
  <adversarial_critique> — failure modes, mitigations, red team

Briefings appear here in arrival order; the most recent is pinned at top.
`.trim();

export const MissionBriefPanel = memo(({ briefings }: MissionBriefPanelProps) => {
  const current = briefings[0];
  const archive = briefings.slice(1, 5);

  return (
    <aside className="h-full w-[340px] shrink-0 border-r border-white/5 bg-black/20 backdrop-blur-xl flex flex-col">
      <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
        <div>
          <div className="t-eyebrow">MISSION_BRIEF</div>
          <div className="font-display font-bold text-[14px] text-command-warm-white leading-tight mt-0.5">
            Active Manifest
          </div>
        </div>
        <div className="t-mono text-[9px] text-command-accent font-bold px-1.5 py-0.5 bg-command-accent/10 rounded">
          {briefings.length}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">
        {current ? (
          <>
            <ANXDisplay raw={current.raw} />
            {archive.length > 0 && (
              <div className="pt-2 mt-2 border-t border-white/5">
                <div className="t-eyebrow mb-2">ARCHIVE</div>
                <div className="space-y-1">
                  {archive.map((b) => (
                    <div key={b.id} className="flex items-center justify-between t-mono text-[10px] text-command-warm-white/50">
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
          <div className="glass-panel p-4">
            <div className="t-eyebrow mb-2">AWAITING_BRIEFING</div>
            <pre className="t-mono text-[10px] text-command-warm-white/55 whitespace-pre-wrap leading-relaxed">
              {EMPTY_GUIDE}
            </pre>
          </div>
        )}
      </div>
    </aside>
  );
});
MissionBriefPanel.displayName = 'MissionBriefPanel';

export default MissionBriefPanel;
