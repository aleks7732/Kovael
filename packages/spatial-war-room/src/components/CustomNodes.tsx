import React, { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

/**
 * AgentHeartbeatNode
 * Tactical telemetry node with heartbeat pulse and glassmorphism.
 * Implements memoization for performance in high-density environments.
 */
export const AgentHeartbeatNode = memo(({ data }: NodeProps) => {
  const status = (data.status as string) || 'IDLE';
  const isOnline = status !== 'OFFLINE';

  return (
    <div className="glass-panel p-4 min-w-[200px] transition-all duration-300 hover:border-command-accent/50 group">
      <Handle type="target" position={Position.Top} className="w-2 h-2 !bg-command-accent/50 border-none" />
      
      {/* Eyebrow */}
      <div className="t-eyebrow mb-1 flex items-center justify-between">
        <span>AGENT_TRACE</span>
        {isOnline && <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.5)]" />}
      </div>

      {/* Title */}
      <div className="text-[16px] font-bold tracking-tight text-command-warm-white leading-none mb-1">
        {data.label as string}
      </div>

      {/* Subtitle / Status */}
      <div className="t-mono text-[9px] uppercase tracking-wider text-command-accent flex items-center gap-1.5">
        <span className="opacity-50">SIG_STATUS:</span>
        <span className="glow-text">{status}</span>
      </div>

      {/* Telemetry Grid */}
      {data.telemetry && (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <div className="bg-black/20 p-2 rounded-md border border-white/5">
            <div className="t-eyebrow !text-[7px] mb-0.5">CPU_LOAD</div>
            <div className="t-mono text-command-warm-white">{(data.telemetry as any).cpu}%</div>
          </div>
          <div className="bg-black/20 p-2 rounded-md border border-white/5">
            <div className="t-eyebrow !text-[7px] mb-0.5">MEM_USE</div>
            <div className="t-mono text-command-warm-white">{(data.telemetry as any).mem}MB</div>
          </div>
        </div>
      )}

      {/* Verification Receipts */}
      {data.receipts && (data.receipts as any[]).length > 0 && (
        <div className="mt-4 border-t border-white/5 pt-3">
          <div className="t-eyebrow !text-[7px] mb-2">RECENT_RECEIPTS</div>
          <div className="space-y-1.5">
            {(data.receipts as any[]).map((r, i) => (
              <div key={i} className="flex items-center justify-between t-mono text-[8px]">
                <div className="flex items-center gap-1.5">
                  <div className={`w-1 h-1 rounded-full ${r.status === 'VERIFIED' ? 'bg-emerald-500' : 'bg-command-accent'}`} />
                  <span className="text-command-warm-white/60">{r.id.slice(0, 8)}</span>
                </div>
                <span className="opacity-30">{r.timestamp.split('T')[1].split('.')[0]}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="w-2 h-2 !bg-command-accent/50 border-none" />
    </div>
  );
});

AgentHeartbeatNode.displayName = 'AgentHeartbeatNode';

/**
 * TaskClusterNode
 * Visualizes recursive task groupings within a tactical matrix.
 */
export const TaskClusterNode = memo(({ data }: NodeProps) => {
  const tasks = (data.tasks as any[]) || [];
  
  const renderTasks = (taskList: any[], depth = 0) => {
    return taskList.map((task, idx) => (
      <div key={`${depth}-${idx}`} className={`flex flex-col gap-1 ${depth > 0 ? 'mt-2 ml-3' : 'mt-3'} pl-3 border-l border-white/5`}>
        <div className="flex justify-between items-center t-mono text-[10px]">
          <span className="text-command-warm-white/70 flex items-center gap-1">
            <span className="opacity-30">[{depth}]</span> {task.name}
          </span>
          <span className={`${task.progress === 100 ? 'text-emerald-400' : 'text-command-accent'} font-bold`}>
            {task.progress}%
          </span>
        </div>
        
        <div className="h-0.5 w-full bg-black/40 rounded-full overflow-hidden">
          <div 
            className={`h-full transition-all duration-700 ease-out ${task.progress === 100 ? 'bg-emerald-500' : 'bg-command-accent'}`}
            style={{ width: `${task.progress}%` }}
          />
        </div>
        
        {task.subTasks && task.subTasks.length > 0 && renderTasks(task.subTasks, depth + 1)}
      </div>
    ));
  };

  return (
    <div className="glass-panel px-4 py-3 min-w-[240px] transition-all duration-300 hover:border-command-accent/30">
      {/* Eyebrow */}
      <div className="flex items-center gap-2 mb-2">
        <div className="t-eyebrow font-bold">CLUSTER_MATRIX</div>
        <div className="h-[1px] flex-1 bg-white/5"></div>
        <div className="t-mono text-[9px] text-command-accent font-bold px-1.5 py-0.5 bg-command-accent/10 rounded">
          {tasks.length}
        </div>
      </div>

      <div className="text-[14px] font-bold mb-1 flex items-center gap-2 tracking-tight text-command-warm-white">
        <div className="w-1.5 h-1.5 bg-command-accent shadow-[0_0_8px_rgba(193,95,60,0.5)]"></div>
        {data.label as string}
      </div>

      {/* Task List (Recursive) */}
      <div className="max-h-[300px] overflow-y-auto pr-1 custom-scrollbar">
        {tasks.length > 0 ? renderTasks(tasks) : (
          <div className="t-mono text-[10px] text-white/20 italic mt-4 text-center border border-dashed border-white/5 py-3 rounded-lg">
            NO_TASKS_QUEUED
          </div>
        )}
      </div>

      <Handle type="target" position={Position.Top} className="w-2 h-2 !bg-white/10 border-none" />
      <Handle type="source" position={Position.Bottom} className="w-2 h-2 !bg-white/10 border-none" />
    </div>
  );
});

TaskClusterNode.displayName = 'TaskClusterNode';

export default {
  AgentHeartbeatNode,
  TaskClusterNode
};
