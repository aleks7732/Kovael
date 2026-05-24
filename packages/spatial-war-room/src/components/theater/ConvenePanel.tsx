import { memo, useState } from 'react';
import type { AgentRosterCard } from '../../store/useWarRoomStore';

interface ConvenePanelProps {
  roster: AgentRosterCard[];
  onTopicCreated?: (topicId: string) => void;
}

export const ConvenePanel = memo(({ roster, onTopicCreated }: ConvenePanelProps) => {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only live Chair Beacon claims are eligible. Static roster status can be
  // "online" even when no agent process has claimed the chair.
  const availableChairs = roster.filter((r) => r.status !== 'offline' && r.chair?.presence === 'live');

  // Toggle selection of a participant
  const toggleSelection = (agentId: string) => {
    setSelectedIds((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId].slice(0, 9) // Limit to max 9 participants
    );
  };

  // Submit REST call to initiate round-table conversation
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError('Please provide a topic title.');
      return;
    }
    if (!goal.trim()) {
      setError('Please provide an instruction/goal to convene on.');
      return;
    }
    if (selectedIds.length === 0) {
      setError('Please select at least one agent to participate.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('http://localhost:8080/api/v1/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: title.trim(),
          participants: selectedIds,
          goal: goal.trim(),
        }),
      });

      if (!response.ok) {
        const txt = await response.text();
        throw new Error(txt || `Server returned status ${response.status}`);
      }

      const res = await response.json() as unknown;
      const topicId = extractTopicId(res);
      
      // Clear forms on success
      setTitle('');
      setGoal('');
      setSelectedIds([]);
      
      if (onTopicCreated && topicId) {
        onTopicCreated(topicId);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to convene panel.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full bg-black/30 border border-white/5 rounded-xl p-4 backdrop-blur-md relative select-none">
      <h3 className="text-[12px] font-bold tracking-wider text-command-accent uppercase mb-3">
        CONVENE VIRTUAL COMMITTEE PANEL
      </h3>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Form Inputs Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Left Column: Title & Goal */}
          <div className="space-y-3">
            <div>
              <label htmlFor="topic-title" className="block text-[9.5px] font-bold text-command-warm-white/55 tracking-wide uppercase mb-1">
                TOPIC TITLE
              </label>
              <input
                id="topic-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Design 100k-node retry strategy"
                className="w-full bg-black/40 border border-white/10 rounded px-3 py-1.5 text-[12px] text-command-warm-white focus:outline-none focus:border-command-accent transition-all placeholder-white/20"
                disabled={loading}
              />
            </div>

            <div>
              <label htmlFor="topic-goal" className="block text-[9.5px] font-bold text-command-warm-white/55 tracking-wide uppercase mb-1">
                CONVENE INSTRUCTION / GOAL
              </label>
              <textarea
                id="topic-goal"
                rows={2}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="What should the agents debate and reconcile? Mention chairs specifically with @name..."
                className="w-full bg-black/40 border border-white/10 rounded px-3 py-1.5 text-[12px] text-command-warm-white focus:outline-none focus:border-command-accent transition-all resize-none placeholder-white/20 scrollbar-thin"
                disabled={loading}
              />
            </div>
          </div>

          {/* Right Column: Participant Selector Grid */}
          <div>
            <span className="block text-[9.5px] font-bold text-command-warm-white/55 tracking-wide uppercase mb-1.5">
              SELECT PARTICIPATING CHAIRS ({selectedIds.length} SELECTED)
            </span>
            <div className="grid grid-cols-3 gap-2 max-h-[135px] overflow-y-auto pr-1 scrollbar-thin">
              {availableChairs.length === 0 ? (
                <div className="col-span-3 text-[10px] text-command-warm-white/25 py-6 text-center">
                  No live chairs registered on the mesh.
                </div>
              ) : (
                availableChairs.map((agent) => {
                  const isSelected = selectedIds.includes(agent.id);
                  const isLiveChair = agent.chair?.presence === 'live';
                  const colorAccent = agent.accent_hex || '#C15F3C';

                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => toggleSelection(agent.id)}
                      disabled={loading}
                      style={{ 
                        borderColor: isSelected ? colorAccent : 'rgba(255,255,255,0.05)',
                        backgroundColor: isSelected ? `${colorAccent}15` : 'rgba(0,0,0,0.3)'
                      }}
                      className={`flex items-center gap-1.5 px-2 py-1.5 rounded border text-left transition-all hover:border-white/10 ${
                        loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                      }`}
                    >
                      <div className="w-5 h-5 rounded-full border border-white/10 bg-black/50 overflow-hidden flex items-center justify-center flex-shrink-0 relative">
                        {agent.portrait_url ? (
                          <img 
                            src={agent.portrait_url} 
                            alt={agent.name} 
                            className="w-full h-full object-cover" 
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        ) : null}
                        <span className="text-[7px] font-extrabold text-white font-mono leading-none">
                          {agent.name.replace(/^nyx-/, '').substring(0, 2).toUpperCase()}
                        </span>
                        
                        {/* Live green beacon pill */}
                        <span className={`absolute bottom-0 right-0 w-1.5 h-1.5 rounded-full ${
                          isLiveChair ? 'bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.7)]' : 'bg-zinc-500'
                        }`} />
                      </div>
                      
                      <div className="flex flex-col min-w-0 leading-tight">
                        <span className="text-[10px] font-bold text-command-warm-white truncate">
                          {agent.name.replace(/^nyx-/, '')}
                        </span>
                        <span className="text-[7.5px] text-command-warm-white/40 truncate">
                          {agent.provider.split(' ')[0]}
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Submit controls */}
        <div className="flex items-center justify-between pt-1.5 border-t border-white/5">
          <div className="text-[10px] text-red-400 font-semibold truncate max-w-[65%]">
            {error && `Error: ${error}`}
          </div>
          
          <button
            type="submit"
            disabled={loading || availableChairs.length === 0}
            className={`px-4 py-1.5 rounded text-[11px] font-bold uppercase tracking-wider transition-all select-none ${
              loading || availableChairs.length === 0
                ? 'bg-zinc-800 text-zinc-500 border border-zinc-700 cursor-not-allowed'
                : 'bg-command-accent/20 border border-command-accent/40 text-command-warm-white hover:bg-command-accent/30 hover:border-command-accent/60 shadow-[0_0_12px_rgba(193,95,60,0.2)]'
            }`}
          >
            {loading ? 'CONVENING...' : 'DISPATCH CONVENER'}
          </button>
        </div>
      </form>
    </div>
  );
});

ConvenePanel.displayName = 'ConvenePanel';
export default ConvenePanel;

function extractTopicId(responseBody: unknown): string | null {
  if (!isRecord(responseBody)) return null;
  if (typeof responseBody.id === 'string') return responseBody.id;
  const nestedTopic = responseBody.topic;
  return isRecord(nestedTopic) && typeof nestedTopic.id === 'string' ? nestedTopic.id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
