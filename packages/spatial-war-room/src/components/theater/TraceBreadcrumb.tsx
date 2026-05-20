import { memo } from 'react';

interface TraceBreadcrumbProps {
  topicId: string;
}

export const TraceBreadcrumb = memo(({ topicId }: TraceBreadcrumbProps) => {
  return (
    <div 
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-[8.5px] font-mono font-bold text-amber-400 hover:bg-amber-500/20 hover:border-amber-500/40 cursor-pointer transition-all uppercase select-none"
      title={`Open OTEL Trace cycle for topic: ${topicId}`}
      onClick={() => {
        // Will be wired on Day 7 to open the OTEL waterfall trace view.
        // For now, emit a console telemetry log or trigger a toast.
        console.log(`[TraceBreadcrumb] Inspecting trace spans for conversation cycle: ${topicId}`);
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
