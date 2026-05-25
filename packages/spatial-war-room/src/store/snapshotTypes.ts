export type AgentLifecycleAction = 'start' | 'stop' | 'restart';
export type AgentRuntimeLifecycleStatus = 'running' | 'stopped' | 'starting' | 'stopping' | 'failed' | 'unknown';
export type AgentHubHealthStatus = 'ok' | 'stale' | 'missing' | 'error' | 'unknown';

export interface AgentRuntimeEntry {
  agentId: string;
  runtime: string;
  running: boolean;
  pid: number | null;
  hubPath?: string;
  status: AgentRuntimeLifecycleStatus;
  managed: boolean;
  lastError?: string;
  updatedAt?: number;
}

export interface AgentRuntimeSnapshot {
  enabled: boolean;
  parkOnIdle: boolean;
  configured: number;
  running: number;
  agents: Record<string, AgentRuntimeEntry>;
  updatedAt: number;
}

export interface ResourceModeSnapshot {
  enabled: boolean;
  mode: 'active' | 'idle';
  idleAfterMs: number;
  sweepIntervalMs: number;
  lastActivityAt: number;
  lastActivityReason: string;
  idleForMs: number;
  trimCount: number;
  lastTrimmedAt: number | null;
  updatedAt: number;
}

export interface AgentHubHealth {
  agentId: string;
  status: AgentHubHealthStatus;
  dispatches?: number;
  accepted?: number;
  running?: number;
  succeeded?: number;
  failed?: number;
  memories?: number;
  checkedAt?: number;
  lastWriteAt?: number | null;
  schemaVersion?: string;
  hubPath?: string;
  error?: string;
}
