import { memo, useCallback } from 'react';

interface TraceBreadcrumbProps {
  topicId: string;
}

export const TraceBreadcrumb = memo(({ topicId }: TraceBreadcrumbProps) => {
  const openTrace = useCallback(() => {
    window.dispatchEvent(new CustomEvent('kovael:open-trace', { detail: { topicId } }));
  }, [topicId]);

  return (
    <div 
      role="button"
      tabIndex={0}
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-[8.5px] font-mono font-bold text-amber-400 hover:bg-amber-500/20 hover:border-amber-500/40 cursor-pointer transition-all uppercase select-none"
      title={`Open OTEL Trace cycle for topic: ${topicId}`}
      onClick={openTrace}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openTrace();
        }
      }}
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
      <span>OTEL TRACE</span>
    </div>
  );
});

TraceBreadcrumb.displayName = 'TraceBreadcrumb';
export default TraceBreadcrumb;
