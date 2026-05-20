import { memo, useEffect, useState } from 'react';

interface ConnectionBannerProps {
  wsConnected: boolean;
}

/**
 * Full-width banner that appears when the cockpit's WS to the orchestrator
 * drops. The mesh-status pill in TopBar already changes colour, but that's
 * small and easy to miss. This banner is unmissable: red, slides down from
 * the top, animates a "reconnecting…" message with a dot counter so the
 * operator sees the cockpit is actively trying.
 *
 * Slides back up cleanly when the connection restores. Stays out of the
 * way during normal operation — only renders when wsConnected === false.
 */
export const ConnectionBanner = memo(({ wsConnected }: ConnectionBannerProps) => {
  // Brief flash of "Reconnected" on transition false → true.
  const [justReconnected, setJustReconnected] = useState(false);
  const [dots, setDots] = useState(0);

  useEffect(() => {
    if (wsConnected) {
      setJustReconnected(true);
      const t = setTimeout(() => setJustReconnected(false), 2500);
      return () => clearTimeout(t);
    }
  }, [wsConnected]);

  useEffect(() => {
    if (wsConnected) return;
    const id = setInterval(() => setDots((d) => (d + 1) % 4), 500);
    return () => clearInterval(id);
  }, [wsConnected]);

  if (wsConnected && !justReconnected) return null;

  if (!wsConnected) {
    return (
      <div
        role="alert"
        className="h-9 px-5 flex items-center justify-center gap-3 border-b border-red-500/30 bg-red-500/10 backdrop-blur-md relative z-30 animate-in"
      >
        <span className="relative flex w-2.5 h-2.5">
          <span className="absolute inset-0 rounded-full bg-red-500 opacity-75 animate-ping" />
          <span className="relative inline-flex w-2.5 h-2.5 rounded-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.7)]" />
        </span>
        <span className="text-[12px] font-semibold text-red-200 tracking-wide">
          Disconnected from orchestrator — reconnecting{'.'.repeat(dots)}
        </span>
        <span className="text-[10px] text-red-300/70 font-medium">
          ws://localhost:8080
        </span>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="h-9 px-5 flex items-center justify-center gap-3 border-b border-emerald-500/30 bg-emerald-500/10 backdrop-blur-md relative z-30"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400" aria-hidden>
        <path d="M20 6 9 17l-5-5" />
      </svg>
      <span className="text-[12px] font-semibold text-emerald-200 tracking-wide">
        Reconnected to orchestrator
      </span>
    </div>
  );
});
ConnectionBanner.displayName = 'ConnectionBanner';

export default ConnectionBanner;
