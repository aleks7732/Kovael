import { memo, type ReactElement } from 'react';

/**
 * AgentIdentityBadge — a per-agent corner glyph that sits on the avatar.
 *
 * Reason it exists: at the cockpit's roster size (36 × 36) the painterly
 * identity tells inside each portrait (Antigravity's ringed-planet pin,
 * Claude-Code's `{ }` tag, Codex's wrench, etc.) become invisible. The
 * badge restores per-agent legibility with a single SVG glyph sitting
 * in the bottom-left of the avatar (the status dot already lives in
 * the bottom-right).
 *
 * Color rule: the chip *background* is tinted with the chair's accent
 * (`accentHex`) so the badge picks up the same accent the AgentCard
 * uses for its left-edge border; the glyph itself renders in warm
 * obsidian (`#0A0A09`) for high contrast on the colored chip. This
 * stays legible against every accent in the design system; using the
 * accent for the glyph stroke instead would wash out at 14×14 on the
 * darker accents (violet, magenta-orange) and on the avatar background.
 *
 * Each glyph is an inline 12 × 12 path so the bundle stays small and
 * there are no image-load races. Unknown agentIds fall back to a
 * generic dot.
 */

interface GlyphProps {
  size?: number;
  className?: string;
}

const Saturn = ({ size = 10, className }: GlyphProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <circle cx="12" cy="12" r="5" />
    <ellipse cx="12" cy="12" rx="11" ry="3.2" transform="rotate(-22 12 12)" />
  </svg>
);

const Braces = ({ size = 10, className }: GlyphProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M8 4c-2 0-3 1-3 3v2c0 1-1 2-2 2 1 0 2 1 2 2v2c0 2 1 3 3 3" />
    <path d="M16 4c2 0 3 1 3 3v2c0 1 1 2 2 2-1 0-2 1-2 2v2c0 2-1 3-3 3" />
  </svg>
);

const Prompt = ({ size = 10, className }: GlyphProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M5 7l5 5-5 5" />
    <path d="M13 19h6" />
  </svg>
);

const Plane = ({ size = 10, className }: GlyphProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M3 13l3-1 4 4 4-9 4 4 3-1-1 3-4 1 4 4-9 4-1-4-4 4 1-3-4-1z" />
  </svg>
);

const Stack = ({ size = 10, className }: GlyphProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M3 7l9-4 9 4-9 4z" />
    <path d="M3 12l9 4 9-4" />
    <path d="M3 17l9 4 9-4" />
  </svg>
);

const Wrench = ({ size = 10, className }: GlyphProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M14 6a4 4 0 1 0 4 4l3 3-4 4-3-3a4 4 0 0 1-4-4 4 4 0 0 1 4-4z" />
    <path d="M5 19l4-4" />
  </svg>
);

const Gamepad = ({ size = 10, className }: GlyphProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <rect x="3" y="8" width="18" height="10" rx="3" />
    <path d="M7 12h3M8.5 10.5v3" />
    <circle cx="15" cy="12" r="0.8" fill="currentColor" />
    <circle cx="17" cy="14" r="0.8" fill="currentColor" />
  </svg>
);

const Refactor = ({ size = 10, className }: GlyphProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M4 7h11a4 4 0 0 1 0 8H9" />
    <path d="M7 12L4 15l3 3" />
  </svg>
);

const Palette = ({ size = 10, className }: GlyphProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M12 3a9 9 0 1 0 0 18c1 0 2-1 1-2-1-2 0-3 2-3h2a4 4 0 0 0 4-4c0-5-4-9-9-9z" />
    <circle cx="7.5" cy="11" r="1" fill="currentColor" />
    <circle cx="11" cy="7.5" r="1" fill="currentColor" />
    <circle cx="15" cy="8.5" r="1" fill="currentColor" />
    <circle cx="17.5" cy="12" r="1" fill="currentColor" />
  </svg>
);

const Dot = ({ size = 10, className }: GlyphProps) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" className={className} aria-hidden>
    <circle cx="12" cy="12" r="5" />
  </svg>
);

interface BadgeSpec {
  Glyph: (p: GlyphProps) => ReactElement;
  label: string;
}

const BADGES: Record<string, BadgeSpec> = {
  'nyx-antigravity': { Glyph: Saturn,   label: 'Ringed-planet pin · supervisor' },
  'nyx-claude-code': { Glyph: Braces,   label: 'Code braces · architecture & review' },
  'nyx-cli':         { Glyph: Prompt,   label: 'Shell prompt · CLI execution' },
  'nyx-agcli':       { Glyph: Plane,    label: 'Aviator · long-running CLI runs' },
  'nyx-adk':         { Glyph: Stack,    label: 'Stack · multi-agent ADK runtime' },
  'nyx-codex':       { Glyph: Wrench,   label: 'Wrench · narrow code edits' },
  'nyx-openclaw':    { Glyph: Gamepad,  label: 'Gamepad · sandbox + game-dev' },
  'nyx-cw':          { Glyph: Refactor, label: 'Refactor arrow · IDE pair-programmer' },
  'shaev':           { Glyph: Palette,  label: 'Palette · visual synthesis' },
};

interface AgentIdentityBadgeProps {
  agentId: string;
  /** Outer chip diameter in px. Default 14. */
  size?: number;
  /**
   * CSS color used as the *chip background* (typically the agent's
   * `accent_hex`). The glyph itself always renders dark — see the
   * component docstring for the rationale.
   */
  accentHex?: string;
}

export const AgentIdentityBadge = memo(({ agentId, size = 14, accentHex }: AgentIdentityBadgeProps) => {
  const spec = BADGES[agentId] ?? { Glyph: Dot, label: 'Agent identity badge' };
  const inner = Math.max(6, Math.floor(size * 0.65));
  const bg = accentHex ?? '#1f1f1d';
  return (
    <span
      role="img"
      aria-label={spec.label}
      title={spec.label}
      className="inline-flex items-center justify-center rounded-full text-[#0A0A09] shadow-[0_0_0_2px_rgba(10,10,9,0.85)]"
      style={{ width: size, height: size, backgroundColor: bg }}
    >
      <spec.Glyph size={inner} className="block" />
    </span>
  );
});
AgentIdentityBadge.displayName = 'AgentIdentityBadge';

export default AgentIdentityBadge;
