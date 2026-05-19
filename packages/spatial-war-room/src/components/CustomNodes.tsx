import React, { memo } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';

/**
 * AgentHeartbeatNode
 * Tactical telemetry node with heartbeat pulse and glassmorphism.
 * Implements memoization for performance in high-density environments.
 */
export const AgentHeartbeatNode = memo(({ data }: NodeProps) => {
  const status = (data.status as string) || 'IDLE';
  const isOnline = status !== 'OFFLINE';

  return (
    <div className="group relative px-4 py-3 rounded-lg bg-command-surface backdrop-blur-md border border-command-border text-white font-mono min-w-[200px] shadow-[0_0_20px_rgba(0,0,0,0.5)] transition-all hover:border-command-accent/50">
      {/* Heartbeat Indicator */}
      <div className="absolute -top-1 -right-1 flex h-3 w-3">
        {isOnline && (
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-command-accent opacity-75"></span>
        )}
        <span className={`relative inline-flex rounded-full h-3 w-3 ${isOnline ? 'bg-command-accent' : 'bg-slate-600'}`}></span>
      </div>
      
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <div className="text-[10px] uppercase tracking-wider text-command-accent/70 font-bold">Agent Trace</div>
        <div className="h-[1px] flex-1 bg-command-border"></div>
      </div>
      
      {/* Content */}
      <div className="text-sm font-bold mb-1 tracking-tight">{data.label as string}</div>
      <div className="text-[10px] text-slate-400 flex justify-between items-center">
        <span className="opacity-50 tracking-tighter">SIG_STATUS:</span>
        <span className={`font-bold ${isOnline ? 'text-command-accent' : 'text-slate-500'}`}>{status}</span>
      </div>
      
      {/* Telemetry Grid */}
      {data.telemetry && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="bg-black/40 p-1.5 rounded border border-white/5">
            <div className="text-[8px] text-slate-500 mb-0.5">CPU_LOAD</div>
            <div className="text-[10px] text-command-accent">{(data.telemetry as any).cpu}%</div>
          </div>
          <div className="bg-black/40 p-1.5 rounded border border-white/5">
            <div className="text-[8px] text-slate-500 mb-0.5">MEM_USE</div>
            <div className="text-[10px] text-command-accent">{(data.telemetry as any).mem}%</div>
          </div>
        </div>
      )}
      
      {/* Connector Handles */}
      <Handle type="target" position={Position.Top} className="w-2 h-2 !bg-command-accent border-none !opacity-50 hover:!opacity-100" />
      <Handle type="source" position={Position.Bottom} className="w-2 h-2 !bg-command-accent border-none !opacity-50 hover:!opacity-100" />
    </div>
  );
});

AgentHeartbeatNode.displayName = 'AgentHeartbeatNode';

/**
 * TaskClusterNode
 * Visualizes recursive task groupings within a tactical matrix.
 * Supports deep nesting and progress tracking.
 */
export const TaskClusterNode = memo(({ data }: NodeProps) => {
  const tasks = (data.tasks as any[]) || [];
  
  // Recursive renderer for nested task groups
  const renderTasks = (taskList: any[], depth = 0) => {
    return taskList.map((task, idx) => (
      <div key={`${depth}-${idx}`} className={`flex flex-col gap-1 ${depth > 0 ? 'mt-2 ml-3' : 'mt-3'} pl-3 border-l border-command-border/30`}>
        <div className="flex justify-between items-center text-[10px]">
          <span className="text-slate-300 flex items-center gap-1">
            <span className="opacity-30">[{depth}]</span> {task.name}
          </span>
          <span className={`${task.progress === 100 ? 'text-emerald-400' : 'text-command-accent'} font-bold`}>
            {task.progress}%
          </span>
        </div>
        
        {/* Progress Bar */}
        <div className="h-0.5 w-full bg-black/40 rounded-full overflow-hidden">
          <div 
            className={`h-full transition-all duration-700 ease-out ${task.progress === 100 ? 'bg-emerald-500' : 'bg-command-accent'}`}
            style={{ width: `${task.progress}%` }}
          />
        </div>
        
        {/* Recursive call for subTasks */}
        {task.subTasks && task.subTasks.length > 0 && renderTasks(task.subTasks, depth + 1)}
      </div>
    ));
  };

  return (
    <div className="px-4 py-3 rounded-lg bg-command-surface/60 backdrop-blur-md border border-command-border/80 text-white font-mono min-w-[240px] shadow-[0_0_30px_rgba(0,0,0,0.3)]">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Cluster Matrix</div>
        <div className="h-[1px] flex-1 bg-command-border/40"></div>
        <div className="text-[10px] text-command-accent font-bold px-1.5 py-0.5 bg-command-accent/10 rounded">
          {tasks.length}
        </div>
      </div>

      <div className="text-sm font-bold mb-1 flex items-center gap-2 tracking-tight">
        <div className="w-2 h-2 bg-command-accent shadow-[0_0_8px_#3b82f6]"></div>
        {data.label as string}
      </div>

      {/* Task List (Recursive) */}
      <div className="max-h-[300px] overflow-y-auto pr-1 custom-scrollbar">
        {tasks.length > 0 ? renderTasks(tasks) : (
          <div className="text-[10px] text-slate-600 italic mt-4 text-center border border-dashed border-command-border/20 py-2 rounded">
            NO_TASKS_QUEUED
          </div>
        )}
      </div>

      {/* Connector Handles */}
      <Handle type="target" position={Position.Top} className="w-2 h-2 !bg-white/20 border-none !opacity-50 hover:!opacity-100" />
      <Handle type="source" position={Position.Bottom} className="w-2 h-2 !bg-white/20 border-none !opacity-50 hover:!opacity-100" />
    </div>
  );
});

TaskClusterNode.displayName = 'TaskClusterNode';

export default {
  AgentHeartbeatNode,
  TaskClusterNode
};
