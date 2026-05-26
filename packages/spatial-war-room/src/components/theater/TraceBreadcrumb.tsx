import { memo, useCallback } from 'react';

interface TraceBreadcrumbProps {
  topicId: string;
  cycleId?: string | null;
}

export const TraceBreadcrumb = memo(({ topicId, cycleId = null }: TraceBreadcrumbProps) => {
  const normalizedCycleId = typeof cycleId === 'string' ? cycleId.trim() : '';
  const traceReady = normalizedCycleId.length > 0;
  const openTrace = useCallback(() => {
    if (!traceReady) return;
    window.dispatchEvent(new CustomEvent('kovael:open-trace', { detail: { topicId, cycleId: normalizedCycleId } }));
  }, [normalizedCycleId, topicId, traceReady]);

  return (
    <button
      type="button"
      disabled={!traceReady}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[8.5px] font-mono font-bold transition-all uppercase select-none ${
        traceReady
          ? 'bg-amber-500/10 border-amber-500/20 text-amber-400 hover:bg-amber-500/20 hover:border-amber-500/40 cursor-pointer'
          : 'bg-white/5 border-white/10 text-command-warm-white/35 cursor-not-allowed'
      }`}
      title={traceReady ? `Open OTEL Trace cycle: ${normalizedCycleId}` : `No OTEL trace cycle is linked to topic ${topicId}`}
      onClick={openTrace}
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
      <span>{traceReady ? 'OTEL TRACE' : 'NO TRACE'}</span>
    </button>
  );
});

TraceBreadcrumb.displayName = 'TraceBreadcrumb';
export default TraceBreadcrumb;
