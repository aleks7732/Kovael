import { memo } from 'react';

interface AgentAvatarFallbackProps {
  agentId: string;
  size?: number;
}

export const AgentAvatarFallback = memo(({ agentId, size = 36 }: AgentAvatarFallbackProps) => {
  // Simple deterministic hash function
  const getHash = (str: string) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return Math.abs(hash);
  };

  const hash = getHash(agentId);
  const hue1 = hash % 360;
  const hue2 = (hue1 + 65) % 360;
  
  // Extract initials (remove "nyx-" prefix if present)
  const cleanId = agentId.replace(/^nyx-/, '');
  const initials = cleanId.substring(0, 2).toUpperCase();

  // Pick deterministic shape paths based on hash to draw a premium tech background grid
  const patternIndex = hash % 3;
  let pattern = null;

  if (patternIndex === 0) {
    // Cyber concentric rings
    pattern = (
      <>
        <circle cx="50" cy="50" r="35" stroke="rgba(255,255,255,0.15)" strokeWidth="1.5" fill="none" />
        <circle cx="50" cy="50" r="25" stroke="rgba(255,255,255,0.25)" strokeWidth="1" fill="none" strokeDasharray="3, 3" />
        <line x1="15" y1="50" x2="85" y2="50" stroke="rgba(255,255,255,0.15)" strokeWidth="0.75" />
        <line x1="50" y1="15" x2="50" y2="85" stroke="rgba(255,255,255,0.15)" strokeWidth="0.75" />
      </>
    );
  } else if (patternIndex === 1) {
    // Tech hexagonal matrix
    pattern = (
      <>
        <polygon points="50,15 80,32.5 80,67.5 50,85 20,67.5 20,32.5" stroke="rgba(255,255,255,0.15)" strokeWidth="1" fill="none" />
        <polygon points="50,25 71,37.5 71,62.5 50,75 29,62.5 29,37.5" stroke="rgba(255,255,255,0.2)" strokeWidth="1" fill="none" strokeDasharray="2, 2" />
      </>
    );
  } else {
    // Modern orbital arcs
    pattern = (
      <>
        <path d="M 20 20 A 42 42 0 0 1 80 80" stroke="rgba(255,255,255,0.25)" strokeWidth="1.5" fill="none" strokeDasharray="4, 4" />
        <path d="M 80 20 A 42 42 0 0 1 20 80" stroke="rgba(255,255,255,0.25)" strokeWidth="1.5" fill="none" />
      </>
    );
  }

  const gradId = `fallback-grad-${hash}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className="rounded-full shadow-lg overflow-hidden border border-white/10"
      aria-label={`Avatar fallback for ${agentId}`}
    >
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={`hsl(${hue1}, 75%, 35%)`} />
          <stop offset="100%" stopColor={`hsl(${hue2}, 85%, 15%)`} />
        </linearGradient>
      </defs>
      
      {/* Gradient base */}
      <rect width="100" height="100" fill={`url(#${gradId})`} />
      
      {/* Decorative tech grid */}
      {pattern}
      
      {/* Subtle outer glow rim */}
      <circle cx="50" cy="50" r="47.5" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" fill="none" />
      
      {/* Core letters */}
      <text
        x="50"
        y="54"
        fill="#ffffff"
        fontSize="30"
        fontWeight="800"
        fontFamily="JetBrains Mono, SF Mono, Courier New, monospace"
        textAnchor="middle"
        dominantBaseline="middle"
        letterSpacing="0.05em"
        style={{
          textShadow: '0 2px 4px rgba(0,0,0,0.5)',
          fill: '#fff'
        }}
      >
        {initials}
      </text>
    </svg>
  );
});

AgentAvatarFallback.displayName = 'AgentAvatarFallback';
export default AgentAvatarFallback;
