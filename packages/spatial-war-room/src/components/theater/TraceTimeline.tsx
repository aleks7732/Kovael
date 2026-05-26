import { memo, useState, useEffect, useMemo, useCallback } from 'react';

export interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: number;
  endTimeUnixNano: number;
  durationMs: number;
  attributes: Record<string, unknown>;
  status: { code: number; message?: string };
  events: Array<{ name: string; timeUnixNano: number; attributes?: Record<string, unknown> }>;
}

export interface CycleTrace {
  cycleId: string;
  traceId: string;
  rootSpanId: string;
  startedAt: number;
  endedAt: number;
  spans: FinishedSpan[];
}

interface TraceTimelineProps {
  initialCycleId?: string | null;
}

export const TraceTimeline = memo(({ initialCycleId = null }: TraceTimelineProps) => {
  const [cycleId, setCycleId] = useState<string | null>(initialCycleId);
  const [trace, setTrace] = useState<CycleTrace | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSpan, setSelectedSpan] = useState<FinishedSpan | null>(null);
  const [zoomRange, setZoomRange] = useState<[number, number]>([0, 100]); // percentage zoom
  const [isOpen, setIsOpen] = useState<boolean>(false);

  // Listen to window-level custom events to open the timeline
  useEffect(() => {
    const handleOpenTrace = (event: Event) => {
      const customEvent = event as CustomEvent<{ topicId?: string; cycleId?: string }>;
      const nextCycleId = typeof customEvent.detail?.cycleId === 'string'
        ? customEvent.detail.cycleId.trim()
        : '';
      if (nextCycleId) {
        setError(null);
        setTrace(null);
        setCycleId(nextCycleId);
        setIsOpen(true);
      }
    };
    window.addEventListener('kovael:open-trace', handleOpenTrace);
    return () => {
      window.removeEventListener('kovael:open-trace', handleOpenTrace);
    };
  }, []);

  // Fetch trace on cycleId change
  useEffect(() => {
    if (!cycleId || !isOpen) {
      setTrace(null);
      return;
    }

    const fetchTrace = async () => {
      setLoading(true);
      setError(null);
      setSelectedSpan(null);
      setZoomRange([0, 100]);
      try {
        const response = await fetch(`http://localhost:8080/api/v1/traces/${cycleId}`);
        if (!response.ok) {
          throw new Error(response.status === 404 ? 'OTEL trace not found for this cycle.' : 'Failed to load trace.');
        }
        const data: CycleTrace = await response.json();
        setTrace(data);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Error fetching telemetry trace');
        setTrace(null);
      } finally {
        setLoading(false);
      }
    };

    fetchTrace();
  }, [cycleId, isOpen]);

  // Compute lane mapping and relative times
  const { minTime, maxTime, totalDurationNano, lanesData } = useMemo(() => {
    if (!trace || trace.spans.length === 0) {
      return { minTime: 0, maxTime: 0, totalDurationNano: 0, lanesData: [] };
    }

    const times = trace.spans.flatMap(s => [s.startTimeUnixNano, s.endTimeUnixNano]);
    const min = Math.min(...times);
    const max = Math.max(...times);
    const duration = max - min;

    // Classify into swimlanes
    const classified: Record<string, FinishedSpan[]> = {
      system: [],
      architect: [],
      operator: [],
      verifier: []
    };

    trace.spans.forEach(span => {
      const name = span.name.toLowerCase();
      if (name.includes('architect')) {
        classified.architect.push(span);
      } else if (name.includes('operator')) {
        classified.operator.push(span);
      } else if (name.includes('verifier')) {
        classified.verifier.push(span);
      } else {
        classified.system.push(span);
      }
    });

    return {
      minTime: min,
      maxTime: max,
      totalDurationNano: duration || 1,
      lanesData: [
        { id: 'system', name: 'System / Orchestrator', spans: classified.system, color: 'bg-zinc-700/60 border-zinc-500/80 text-zinc-300' },
        { id: 'architect', name: 'Architect Dispatch', spans: classified.architect, color: 'bg-amber-500/20 border-amber-500/60 text-amber-300' },
        { id: 'operator', name: 'Operator Execution (Tool Call)', spans: classified.operator, color: 'bg-blue-500/20 border-blue-500/60 text-blue-300' },
        { id: 'verifier', name: 'Verifier Audit', spans: classified.verifier, color: 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' }
      ]
    };
  }, [trace]);

  const handleSpanClick = useCallback((span: FinishedSpan) => {
    setSelectedSpan(span);
  }, []);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setCycleId(null);
  }, []);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto animate-[fadeIn_0.2s_ease-out]">
      <div 
        role="dialog"
        aria-modal="true"
        aria-label={`OTel Trace Timeline - ${cycleId || 'loading'}`}
        className="w-full max-w-5xl bg-[#0C0C0B] border border-white/10 rounded-xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]"
      >
        {/* Header Section */}
        <header className="px-5 py-4 border-b border-white/5 bg-black/40 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-2.5 h-2.5 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)] animate-pulse" />
            <div className="flex flex-col">
              <span className="text-[10px] font-bold tracking-widest text-command-warm-white/50 uppercase font-mono">
                OTel GenAI Trace Timeline Canvas
              </span>
              <span className="text-[13px] font-bold text-command-warm-white flex items-center gap-1.5">
                Cycle: <span className="font-mono text-amber-400 select-all text-[11px]">{cycleId}</span>
              </span>
            </div>
          </div>
          <button 
            onClick={handleClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg border border-white/10 text-command-warm-white/60 hover:text-command-warm-white hover:bg-white/5 transition-all"
            aria-label="Close Trace Timeline"
          >
            ✕
          </button>
        </header>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 min-h-0 scrollbar-thin">
          {loading && (
            <div className="py-24 text-center text-command-warm-white/35 font-mono text-[11px] uppercase tracking-widest animate-pulse">
              Synthesizing trace timelines from ring-buffer...
            </div>
          )}

          {error && (
            <div className="py-16 text-center">
              <div className="text-red-400 font-bold font-mono text-[11.5px] uppercase tracking-wide">
                {error}
              </div>
              <div className="text-command-warm-white/40 text-[10.5px] mt-1.5 max-w-md mx-auto">
                Verify that the orchestrator is running and that this conversation cycle had active OTel instrumentation spans.
              </div>
            </div>
          )}

          {trace && !loading && (
            <>
              {/* Timeline Info cards */}
              <div className="grid grid-cols-4 gap-2 text-[10px] bg-black/30 border border-white/5 rounded-lg p-3">
                <div className="flex flex-col">
                  <span className="text-command-warm-white/40 uppercase tracking-wide">Trace ID</span>
                  <span className="font-mono font-bold text-command-warm-white/95 truncate select-all">{trace.traceId}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-command-warm-white/40 uppercase tracking-wide">Duration</span>
                  <span className="font-bold text-command-warm-white/95 font-mono">
                    {((maxTime - minTime) / 1000000).toFixed(2)} ms
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-command-warm-white/40 uppercase tracking-wide">Total Spans</span>
                  <span className="font-bold text-command-warm-white/95 font-mono">{trace.spans.length}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-command-warm-white/40 uppercase tracking-wide">Instrumented Phases</span>
                  <span className="font-bold text-emerald-400 font-mono">
                    {lanesData.filter(l => l.spans.length > 0).length} / 4
                  </span>
                </div>
              </div>

              {/* Interactive Zoom Controls */}
              <div className="flex items-center gap-3 bg-black/20 px-3 py-2 border border-white/5 rounded-lg text-[9.5px]">
                <span className="text-command-warm-white/40 uppercase font-mono font-bold">Timeline Zoom Window</span>
                <input 
                  type="range" 
                  min="0" 
                  max="90" 
                  value={zoomRange[0]} 
                  onChange={(e) => {
                    const start = Number(e.target.value);
                    setZoomRange([start, Math.max(start + 10, zoomRange[1])]);
                  }}
                  className="flex-1 accent-amber-500 h-1 bg-zinc-800 rounded-lg cursor-pointer"
                />
                <input 
                  type="range" 
                  min="10" 
                  max="100" 
                  value={zoomRange[1]} 
                  onChange={(e) => {
                    const end = Number(e.target.value);
                    setZoomRange([Math.min(end - 10, zoomRange[0]), end]);
                  }}
                  className="flex-1 accent-amber-500 h-1 bg-zinc-800 rounded-lg cursor-pointer"
                />
                <span className="font-mono text-amber-400 font-bold shrink-0">
                  [{zoomRange[0]}% - {zoomRange[1]}%]
                </span>
                <button
                  onClick={() => setZoomRange([0, 100])}
                  className="px-2 py-0.5 rounded border border-white/10 hover:bg-white/5 text-[9px]"
                >
                  RESET
                </button>
              </div>

              {/* Timeline Swimlanes Container */}
              <div className="bg-black/35 border border-white/5 rounded-xl p-4 space-y-6 relative overflow-hidden select-none">
                {/* Swimlanes */}
                <div className="space-y-4">
                  {lanesData.map(lane => (
                    <div 
                      key={lane.id} 
                      className="grid grid-cols-[160px_1fr] items-center border-b border-white/5 pb-4 last:border-b-0 last:pb-0 min-h-[48px]"
                    >
                      {/* Swimlane Info */}
                      <div className="pr-4 shrink-0">
                        <div className="text-[11px] font-bold text-command-warm-white/95">{lane.name}</div>
                        <div className="text-[9px] text-command-warm-white/35 font-mono uppercase mt-0.5">
                          {lane.spans.length} span{lane.spans.length === 1 ? '' : 's'}
                        </div>
                      </div>

                      {/* Swimlane Track */}
                      <div className="h-9 relative bg-white/2 rounded-lg border border-dashed border-white/5 overflow-hidden">
                        {lane.spans.map(span => {
                          const leftPct = ((span.startTimeUnixNano - minTime) / totalDurationNano) * 100;
                          const widthPct = ((span.endTimeUnixNano - span.startTimeUnixNano) / totalDurationNano) * 100;

                          // Adjust for Zoom
                          const zoomScale = 100 / (zoomRange[1] - zoomRange[0]);
                          const zoomedLeft = (leftPct - zoomRange[0]) * zoomScale;
                          const zoomedWidth = widthPct * zoomScale;

                          // Clip spans completely out of zoom bounds
                          if (zoomedLeft + zoomedWidth < 0 || zoomedLeft > 100) return null;

                          const durationText = `${span.durationMs.toFixed(1)}ms`;
                          const isSelected = selectedSpan?.spanId === span.spanId;

                          return (
                            <button
                              key={span.spanId}
                              onClick={() => handleSpanClick(span)}
                              style={{
                                left: `${Math.max(0, zoomedLeft)}%`,
                                width: `${Math.min(100 - Math.max(0, zoomedLeft), zoomedWidth || 0.8)}%`
                              }}
                              className={`absolute top-1.5 bottom-1.5 rounded border text-left flex flex-col justify-center px-2 cursor-pointer select-none transition-all duration-150 overflow-hidden ${lane.color} ${
                                isSelected ? 'ring-2 ring-amber-400 scale-[1.01]' : 'hover:scale-[1.005]'
                              }`}
                              title={`${span.name} (${durationText})`}
                            >
                              <div className="text-[9.5px] font-bold leading-none truncate">{span.name}</div>
                              <div className="text-[7.5px] opacity-75 font-mono mt-0.5 leading-none">{durationText}</div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                {/* X-Axis Tick Marks */}
                <div className="grid grid-cols-[160px_1fr] pt-2 select-none">
                  <div />
                  <div className="flex justify-between text-[8px] font-mono text-command-warm-white/25 px-1">
                    <span>0 ms</span>
                    <span>{(((maxTime - minTime) * 0.25) / 1000000).toFixed(1)} ms</span>
                    <span>{(((maxTime - minTime) * 0.5) / 1000000).toFixed(1)} ms</span>
                    <span>{(((maxTime - minTime) * 0.75) / 1000000).toFixed(1)} ms</span>
                    <span>{((maxTime - minTime) / 1000000).toFixed(1)} ms</span>
                  </div>
                </div>
              </div>

              {/* Span Detail Panel */}
              {selectedSpan && (
                <div className="border border-white/10 rounded-xl bg-black/45 p-4 space-y-3.5 animate-[fadeIn_0.15s_ease-out]">
                  <header className="flex items-center justify-between border-b border-white/5 pb-2">
                    <div className="flex flex-col">
                      <span className="text-[9px] font-bold text-amber-500 uppercase tracking-widest font-mono">
                        Active Telemetry Span Inspector
                      </span>
                      <span className="text-[12.5px] font-bold text-command-warm-white">{selectedSpan.name}</span>
                    </div>
                    <span className="px-2 py-0.5 rounded bg-white/5 text-[9.5px] font-mono text-command-warm-white/70">
                      {selectedSpan.durationMs.toFixed(2)} ms
                    </span>
                  </header>

                  <div className="grid grid-cols-2 gap-4">
                    {/* General attributes */}
                    <div className="space-y-2">
                      <div className="text-[9px] font-bold tracking-wider text-command-warm-white/50 uppercase font-mono">
                        Span Context Attributes
                      </div>
                      <div className="space-y-1.5 max-h-[160px] overflow-y-auto pr-1 text-[10px] font-mono scrollbar-thin">
                        {Object.entries(selectedSpan.attributes).length === 0 ? (
                          <div className="text-command-warm-white/20 italic">No attributes recorded</div>
                        ) : (
                          Object.entries(selectedSpan.attributes).map(([key, val]) => (
                            <div key={key} className="flex justify-between gap-3 border-b border-white/2 py-0.5 truncate last:border-b-0">
                              <span className="text-zinc-500 truncate shrink-0 max-w-[150px]">{key}</span>
                              <span className="text-zinc-300 truncate select-all">{String(val)}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    {/* GenAI Metadata highlights */}
                    <div className="space-y-2.5">
                      <div className="text-[9px] font-bold tracking-wider text-command-warm-white/50 uppercase font-mono">
                        GenAI Semantic Summary
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-[10px]">
                        <div className="bg-white/2 border border-white/5 p-2 rounded flex flex-col">
                          <span className="text-command-warm-white/40">Estimated Input Tokens</span>
                          <span className="font-bold text-command-warm-white font-mono text-[11px] mt-0.5">
                            {Number(selectedSpan.attributes['kovael.gen_ai.response.estimated_input_tokens']) || '—'}
                          </span>
                        </div>
                        <div className="bg-white/2 border border-white/5 p-2 rounded flex flex-col">
                          <span className="text-command-warm-white/40">Estimated Output Tokens</span>
                          <span className="font-bold text-command-warm-white font-mono text-[11px] mt-0.5">
                            {Number(selectedSpan.attributes['kovael.gen_ai.response.estimated_output_tokens']) || '—'}
                          </span>
                        </div>
                        <div className="bg-white/2 border border-white/5 p-2 rounded flex flex-col">
                          <span className="text-command-warm-white/40">Agent Identity</span>
                          <span className="font-bold text-amber-300 font-mono text-[10px] mt-0.5 truncate">
                            {String(selectedSpan.attributes['kovael.agent.id'] || 'system')}
                          </span>
                        </div>
                        <div className="bg-white/2 border border-white/5 p-2 rounded flex flex-col">
                          <span className="text-command-warm-white/40">Linked Cycle ID</span>
                          {selectedSpan.attributes['kovael.cycle.id'] ? (
                            <button
                              onClick={() => {
                                const newCycleId = String(selectedSpan.attributes['kovael.cycle.id']);
                                if (newCycleId && newCycleId !== cycleId) {
                                  setCycleId(newCycleId);
                                }
                              }}
                              className="text-left font-bold text-emerald-400 hover:text-emerald-300 transition-colors font-mono text-[10px] mt-0.5 truncate hover:underline focus:outline-none"
                              title="Click to jump to this cycle's trace"
                            >
                              {String(selectedSpan.attributes['kovael.cycle.id'])} ↗
                            </button>
                          ) : (
                            <span className="font-bold text-command-warm-white/40 font-mono text-[10px] mt-0.5">
                              {cycleId || '—'}
                            </span>
                          )}
                        </div>
                        <div className="bg-white/2 border border-white/5 p-2 rounded flex flex-col">
                          <span className="text-command-warm-white/40">OTel GenAI System</span>
                          <span className="font-bold text-command-warm-white/70 font-mono text-[10px] mt-0.5 truncate">
                            {String(selectedSpan.attributes['gen_ai.system'] || 'kovael')}
                          </span>
                        </div>
                        <div className="bg-white/2 border border-white/5 p-2 rounded flex flex-col">
                          <span className="text-command-warm-white/40">Verifier Confidence</span>
                          <span className="font-bold text-emerald-400 font-mono text-[10px] mt-0.5">
                            {selectedSpan.attributes['kovael.verifier.confidence'] !== undefined
                              ? `${Math.round(Number(selectedSpan.attributes['kovael.verifier.confidence']) * 100)}%`
                              : '—'}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Span Events block */}
                  {selectedSpan.events.length > 0 && (
                    <div className="pt-2 border-t border-white/5 space-y-1.5">
                      <div className="text-[9px] font-bold tracking-wider text-command-warm-white/50 uppercase font-mono">
                        Span Telemetry Milestones & Events ({selectedSpan.events.length})
                      </div>
                      <div className="space-y-1 max-h-[100px] overflow-y-auto text-[10px] scrollbar-thin">
                        {selectedSpan.events.map((evt, i) => (
                          <div key={i} className="flex items-start gap-3 border-b border-white/2 py-1 last:border-0">
                            <span className="font-mono text-emerald-400 shrink-0 select-none">
                              [+{((evt.timeUnixNano - selectedSpan.startTimeUnixNano) / 1000000).toFixed(1)} ms]
                            </span>
                            <div className="flex-1 font-mono text-zinc-300 font-bold">{evt.name}</div>
                            {evt.attributes && (
                              <span className="text-zinc-500 font-mono text-[9px] truncate max-w-[200px]">
                                {JSON.stringify(evt.attributes)}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer info bar */}
        <footer className="px-5 py-3.5 border-t border-white/5 bg-black/20 text-[9px] text-command-warm-white/35 flex items-center justify-between font-mono">
          <span>Telemetry bridge matches OpenTelemetry GenAI Semantic Convention v1.27.0</span>
          <span>Mesh: online</span>
        </footer>
      </div>
    </div>
  );
});

TraceTimeline.displayName = 'TraceTimeline';
export default TraceTimeline;
