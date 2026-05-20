import { memo, useEffect, useRef } from 'react';
import type { ConversationMessage, AgentRosterCard } from '../../store/useWarRoomStore';
import { AgentAvatarFallback } from '../AgentAvatarFallback';

interface MessageListProps {
  messages: ConversationMessage[];
  roster: AgentRosterCard[];
  activeTopicId: string | null;
  activeSpeakerId: string | null;
}

export const MessageList = memo(({ messages, roster, activeTopicId, activeSpeakerId }: MessageListProps) => {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll transcript pane when new tokens or messages stream in
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activeTopicId]);

  // Find dynamic details of sender
  const getSenderDetails = (senderId: string) => {
    const card = roster.find((r) => r.id === senderId);
    return {
      name: card?.name ? card.name.replace(/^nyx-/, '') : senderId,
      portraitUrl: card?.portrait_url,
      accentHex: card?.accent_hex || '#C15F3C',
    };
  };

  // Convert raw message text, parsing @mention handles into interactive highlight chips
  const formatContent = (content: string) => {
    if (!content) return null;
    const parts = content.split(/(@[a-zA-Z0-9_-]+)/g);
    
    return parts.map((part, i) => {
      if (part.startsWith('@')) {
        const targetId = part.slice(1);
        const exists = roster.some((r) => r.id === targetId || r.name.toLowerCase() === targetId.toLowerCase());
        
        if (exists) {
          return (
            <span
              key={i}
              onClick={() => {
                // Focus and flash highlight the roster card
                const el = document.getElementById(`roster-card-${targetId}`);
                if (el) {
                  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  el.classList.add('ring-2', 'ring-command-accent', 'scale-102');
                  setTimeout(() => {
                    el.classList.remove('ring-2', 'ring-command-accent', 'scale-102');
                  }, 1200);
                }
              }}
              className="inline-block px-1.5 py-0.5 rounded bg-command-accent/15 border border-command-accent/30 text-[10px] font-bold text-command-accent hover:bg-command-accent/25 cursor-pointer transition-all mx-0.5 select-none"
            >
              {part}
            </span>
          );
        }
      }
      return <span key={i} className="whitespace-pre-wrap">{part}</span>;
    });
  };

  if (!activeTopicId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-command-warm-white/35 min-h-[250px] select-none">
        <svg className="w-12 h-12 mb-3 opacity-20 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
        <span className="text-[12px] font-medium tracking-wide uppercase">No Active Conversation Thread</span>
        <span className="text-[10px] text-command-warm-white/20 mt-1">Convene a panel below or select a topic from the sidebar history.</span>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-[300px] flex flex-col bg-black/10 rounded-xl border border-white/5 overflow-hidden">
      {/* List container header */}
      <div className="px-4 py-2 border-b border-white/5 bg-black/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-command-accent animate-pulse" />
          <span className="text-[10.5px] font-bold tracking-wide uppercase text-command-warm-white/70">
            CONVERSATION TRANSCRIPT
          </span>
        </div>
        <div className="text-[9px] text-command-warm-white/40 tracking-wider">
          {messages.length} MESSAGE{messages.length === 1 ? '' : 'S'}
        </div>
      </div>

      {/* Transcript Scroll Area */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 max-h-[420px] scrollbar-thin">
        {messages.length === 0 ? (
          <div className="py-12 flex flex-col items-center justify-center text-command-warm-white/25">
            <span className="text-[11px] uppercase tracking-widest animate-pulse">Awaiting first participant reply...</span>
          </div>
        ) : (
          messages.map((msg, index) => {
            const sender = getSenderDetails(msg.senderId);
            const isSystem = msg.role === 'system';
            const isUser = msg.role === 'user';
            
            // Estimate tokens on content (approx. 4 chars per token)
            const inputTokens = Math.ceil(msg.content.length * 0.15);
            const outputTokens = Math.ceil(msg.content.length * 0.25);
            const totalEstTokens = isSystem ? inputTokens : outputTokens;

            const isLastMessage = index === messages.length - 1;
            const isCurrentlyStreaming = isLastMessage && activeSpeakerId === msg.senderId;

            if (isSystem) {
              return (
                <div key={msg.id} className="flex justify-center select-none py-1">
                  <div className="px-3 py-1 rounded bg-zinc-900/60 border border-white/5 text-[9px] font-medium tracking-wide text-zinc-400 max-w-[90%] text-center">
                    SYSTEM: {msg.content}
                  </div>
                </div>
              );
            }

            return (
              <div 
                key={msg.id} 
                className={`flex gap-3 text-[12px] leading-relaxed transition-all duration-300 ${
                  isUser ? 'flex-row-reverse' : 'flex-row'
                }`}
              >
                {/* Avatar Icon / Fallback */}
                <div className="flex-shrink-0 w-8 h-8 rounded-full border border-white/5 bg-black/40 overflow-hidden flex items-center justify-center relative">
                  {sender.portraitUrl ? (
                    <img 
                      src={sender.portraitUrl} 
                      alt={sender.name} 
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                        const parent = e.currentTarget.parentElement;
                        if (parent) {
                          const svg = parent.querySelector('svg');
                          if (svg) svg.style.display = 'block';
                        }
                      }}
                    />
                  ) : null}
                  <div className={sender.portraitUrl ? 'hidden' : 'block'}>
                    <AgentAvatarFallback agentId={msg.senderId} size={30} />
                  </div>
                </div>

                {/* Message Bubble Container */}
                <div className={`max-w-[75%] flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
                  {/* Bubble Header */}
                  <div className="flex items-center gap-2 mb-1 px-1 text-[9.5px]">
                    <span 
                      style={{ color: sender.accentHex }}
                      className="font-bold tracking-wide uppercase"
                    >
                      {isUser ? 'OPERATOR (YOU)' : sender.name}
                    </span>
                    <span className="text-command-warm-white/35 font-mono">
                      {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                  </div>

                  {/* Bubble Content Body */}
                  <div 
                    style={{ 
                      borderColor: isCurrentlyStreaming ? `${sender.accentHex}40` : 'rgba(255,255,255,0.05)',
                      boxShadow: isCurrentlyStreaming ? `0 0 10px ${sender.accentHex}10` : 'none'
                    }}
                    className={`px-3 py-2.5 rounded-lg border backdrop-blur-sm relative transition-all duration-200 ${
                      isUser 
                        ? 'bg-command-accent/10 text-command-warm-white rounded-tr-none' 
                        : 'bg-black/30 text-command-warm-white/90 rounded-tl-none'
                    }`}
                  >
                    {formatContent(msg.content)}

                    {/* Progress typing terminal block cursor */}
                    {isCurrentlyStreaming && (
                      <span className="inline-block w-1.5 h-3 ml-1 bg-command-accent shadow-[0_0_8px_rgba(193,95,60,0.8)] animate-pulse align-middle" />
                    )}
                  </div>

                  {/* Bubble Footer Token usage */}
                  {!isUser && (
                    <div className="mt-1 px-1 flex items-center gap-1.5 text-[8.5px] text-command-warm-white/30 font-mono">
                      <span>{totalEstTokens} tokens</span>
                      <span>•</span>
                      <span>{Math.ceil(msg.content.length / 5)} words</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
});

MessageList.displayName = 'MessageList';
export default MessageList;
