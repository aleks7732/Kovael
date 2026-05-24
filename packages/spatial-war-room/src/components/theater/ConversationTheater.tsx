import { memo, useState, useEffect } from 'react';
import { useWarRoomStore } from '../../store/useWarRoomStore';
import { Stage } from './Stage';
import { MessageList } from './MessageList';
import { ConvenePanel } from './ConvenePanel';
import { StoppingCard } from './StoppingCard';
import { TraceBreadcrumb } from './TraceBreadcrumb';
import { TraceTimeline } from './TraceTimeline';
import { CommitteeDrawer } from './CommitteeDrawer';
import { ComfyMixerPanel } from './ComfyMixerPanel';
import { ResizeHandle } from '../ResizeHandle';
import { usePersistentDimension } from '../../hooks/usePersistentDimension';

export const ConversationTheater = memo(() => {
  const topics = useWarRoomStore((s) => s.topics);
  const messagesByTopic = useWarRoomStore((s) => s.messagesByTopic);
  const activeTopicId = useWarRoomStore((s) => s.activeTopicId);
  const stoppingCriterion = useWarRoomStore((s) => s.conversationStoppingCriterion);
  const roster = useWarRoomStore((s) => s.agentRoster);
  
  const selectTopic = useWarRoomStore((s) => s.selectTopic);
  const openConversation = useWarRoomStore((s) => s.openConversation);

  const [closingId, setClosingId] = useState<string | null>(null);
  const compactLayout = typeof window !== 'undefined' && window.innerWidth < 1180;
  const [topicRailWidth, setTopicRailWidth] = usePersistentDimension('kovael.layout.theater.topicRailWidth', compactLayout ? 120 : 256, 120, 420);
  const [committeeWidth, setCommitteeWidth] = usePersistentDimension('kovael.layout.theater.committeeWidth', compactLayout ? 140 : 288, 120, 420);
  const [stageHeight, setStageHeight] = usePersistentDimension('kovael.layout.theater.stageHeight', 360, 260, 680);

  // Active topic object
  const activeTopic = topics.find((t) => t.id === activeTopicId) || null;
  const messages = activeTopicId ? messagesByTopic[activeTopicId] || [] : [];
  const activeCriterion = activeTopicId ? stoppingCriterion[activeTopicId] || null : null;
  const showTopicRail = topics.length > 0;
  const showCommitteeDrawer = activeTopicId !== null;

  // Determine active speaker (last assistant message sender if thread is active)
  let activeSpeakerId: string | null = null;
  if (activeTopic?.active && messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === 'assistant') {
      activeSpeakerId = lastMsg.senderId;
    }
  }

  // Load active topics history from orchestrator backend on mount
  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const response = await fetch('http://localhost:8080/api/v1/state');
        if (response.ok) {
          const state = await response.json();
          // Backfill topics if they exist in state
          if (state.conversations && Array.isArray(state.conversations)) {
            for (const topic of state.conversations) {
              openConversation({
                id: topic.id,
                title: topic.title,
                participants: topic.participants,
                active: topic.active,
              });
            }
          }
        }
      } catch (err) {
        console.warn('[ConversationTheater] Failed to pre-fetch history from state endpoint', err);
      }
    };
    fetchHistory();
  }, [openConversation]);

  // Request topic termination close
  const handleCloseTopic = async (topicId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setClosingId(topicId);
    try {
      const response = await fetch(`http://localhost:8080/api/v1/conversations/${topicId}/close`, {
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error('Failed to close thread.');
      }
      // Zustand actions will receive 'conversation_topic_closed' from WS and update accordingly
    } catch (err) {
      console.error(err);
    } finally {
      setClosingId(null);
    }
  };

  return (
    <div className="w-full flex-1 flex min-h-0 text-command-warm-white select-none animate-[fadeIn_0.3s_ease-out]">
      {/* LEFT SIDEBAR: Topic History thread selection */}
      {showTopicRail && (
        <>
          <aside
            data-layout-panel="theater-topics"
            className="border-r border-white/5 bg-black/20 flex flex-col min-h-0 shrink-0"
            style={{ width: topicRailWidth }}
          >
            {/* Sidebar Header */}
            <div className="p-4 border-b border-white/5 bg-black/10 flex items-center justify-between">
              <span className="text-[10px] font-extrabold tracking-wider text-command-warm-white/60 uppercase">
                CONVENED DEBATES
              </span>
              <span className="px-1.5 py-0.5 rounded bg-white/5 text-[9px] font-mono text-command-warm-white/45">
                {topics.length} THREADS
              </span>
            </div>

            {/* Topics List */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1.5 scrollbar-thin">
              {topics.map((topic) => {
                const isActive = topic.id === activeTopicId;

                return (
                  <div
                    key={topic.id}
                    onClick={() => selectTopic(topic.id)}
                    className={`w-full p-3 rounded-lg border text-left cursor-pointer transition-all duration-150 flex flex-col gap-1.5 ${
                      isActive
                        ? 'bg-command-accent/10 border-command-accent/40 shadow-[0_0_10px_rgba(193,95,60,0.15)]'
                        : 'bg-black/30 border-white/5 hover:bg-black/50 hover:border-white/10'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[11.5px] font-bold text-command-warm-white/90 leading-tight line-clamp-2">
                        {topic.title}
                      </span>

                      {/* Live active beacon */}
                      {topic.active ? (
                        <span className="flex-shrink-0 w-2 h-2 rounded-full bg-command-accent shadow-[0_0_6px_rgba(193,95,60,0.8)] animate-pulse" />
                      ) : (
                        <span className="flex-shrink-0 w-2 h-2 rounded-full bg-zinc-600" />
                      )}
                    </div>

                    {/* Topic footer details */}
                    <div className="flex items-center justify-between mt-1 pt-1.5 border-t border-white/5 text-[9px] text-command-warm-white/35">
                      <span className="font-mono">
                        {topic.participants.length} CHAIR{topic.participants.length === 1 ? '' : 'S'}
                      </span>

                      {/* Manual Close Action */}
                      {topic.active && (
                        <button
                          onClick={(e) => handleCloseTopic(topic.id, e)}
                          disabled={closingId === topic.id}
                          className="px-1.5 py-0.5 rounded border border-red-500/30 text-[8px] font-bold uppercase text-red-400 hover:bg-red-500/10 transition-all select-none"
                        >
                          {closingId === topic.id ? 'CLOSING...' : 'HALT'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>
          <ResizeHandle
            axis="x"
            title="Resize debate history"
            onResize={(delta) => setTopicRailWidth((width) => width + delta)}
          />
        </>
      )}

      {/* CENTER MAIN STAGE WORKSPACE */}
      <main className="flex-1 flex flex-col min-h-0 bg-black/10 overflow-y-auto p-4 space-y-4 scrollbar-thin">
        {activeTopic ? (
          <>
            {/* Thread Navigation / Header Overlay */}
            <div className="w-full flex items-center justify-between bg-black/20 border border-white/5 rounded-xl px-4 py-2.5 backdrop-blur-sm">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold tracking-widest text-command-warm-white/45 uppercase font-mono">
                  ACTIVE DEBATE THREAD
                </span>
                <span className="text-[12px] font-extrabold text-command-warm-white/80">•</span>
                <span className="text-[12px] font-extrabold text-command-warm-white">
                  {activeTopic.title}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <TraceBreadcrumb topicId={activeTopic.id} />
                {activeTopic.active && (
                  <span className="px-2 py-0.5 rounded bg-command-accent/15 border border-command-accent/30 text-[9px] font-bold text-command-accent tracking-widest animate-pulse uppercase">
                    STREAMING DELTAS
                  </span>
                )}
              </div>
            </div>

            {/* Stage: Seating seating table */}
            <Stage
              roster={roster}
              participantIds={activeTopic.participants}
              activeSpeakerId={activeSpeakerId}
              height={stageHeight}
            />
            <ResizeHandle
              axis="y"
              title="Resize round-table stage"
              onResize={(delta) => setStageHeight((height) => height + delta)}
            />

            {/* Consensus stop alert (if triggered) */}
            <StoppingCard criterion={activeCriterion} />

            <ComfyMixerPanel />

            {/* Thread messages logs */}
            <MessageList 
              messages={messages} 
              roster={roster} 
              activeTopicId={activeTopicId}
              activeSpeakerId={activeSpeakerId}
            />
          </>
        ) : (
          /* Empty/Standby State Theater Stage background */
          <div
            data-layout-panel="theater-standby"
            className="relative flex-1 flex flex-col items-center justify-center p-8 text-center bg-black/15 border border-dashed border-white/5 rounded-xl min-h-[300px]"
            style={{ minHeight: stageHeight }}
          >
            <div className="absolute top-3 left-3 right-3 flex items-center justify-between gap-3">
              <span className="px-1.5 py-0.5 rounded bg-white/5 text-[9px] font-mono text-command-warm-white/45">
                0 THREADS
              </span>
              <span className="text-[10px] text-command-warm-white/25 truncate">
                No previous threads found. Convene a new panel to start.
              </span>
            </div>
            <div className="relative w-20 h-20 mb-4 flex items-center justify-center">
              <div className="absolute inset-0 rounded-full border border-white/5 bg-command-accent/5 animate-pulse" />
              <svg className="w-8 h-8 text-command-accent/40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <h3 className="text-[13px] font-bold tracking-widest text-command-accent uppercase">
              ROUND-TABLE THEATER DEBATES
            </h3>
            <p className="text-[11px] mt-2 text-command-warm-white/40 max-w-[360px] leading-relaxed">
              The Theater is currently idle. Convene an active debate of up to nine agent chairs below to observe live model-to-model cooperation streaming token-by-token.
            </p>
          </div>
        )}
        {!activeTopic && (
          <ResizeHandle
            axis="y"
            title="Resize theater standby"
            onResize={(delta) => setStageHeight((height) => height + delta)}
          />
        )}

        {/* Convene input panel dock at bottom */}
        <ConvenePanel roster={roster} onTopicCreated={(id) => selectTopic(id)} />
      </main>
      {showCommitteeDrawer && (
        <>
          <ResizeHandle
            axis="x"
            title="Resize committee drawer"
            onResize={(delta) => setCommitteeWidth((width) => width - delta)}
          />
          <CommitteeDrawer topicId={activeTopicId} width={committeeWidth} />
        </>
      )}
      <TraceTimeline />
    </div>
  );
});

ConversationTheater.displayName = 'ConversationTheater';
export default ConversationTheater;
