import type {
  AgentHubHealth,
  AgentHubHealthStatus,
  AgentRuntimeEntry,
  AgentRuntimeLifecycleStatus,
  AgentRuntimeSnapshot,
  ResourceModeSnapshot,
} from './snapshotTypes.js';

export function normalizeAgentRuntimeSnapshot(value: unknown): AgentRuntimeSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;

  const updatedAt = numberValue(record.updatedAt) ?? Date.now();
  const rawAgents = runtimeAgentItems(record.agents);
  const agents: Record<string, AgentRuntimeEntry> = {};
  for (const raw of rawAgents) {
    const normalized = normalizeAgentRuntimeEntry(raw, updatedAt);
    if (normalized) agents[normalized.agentId] = normalized;
  }

  const configured = numberValue(record.configured) ?? rawAgents.length;
  const running = numberValue(record.running) ?? Object.values(agents).filter((agent) => agent.running).length;

  return {
    enabled: booleanValue(record.enabled, false),
    parkOnIdle: booleanValue(record.parkOnIdle ?? record.park_on_idle, true),
    configured,
    running,
    agents,
    updatedAt,
  };
}

export function normalizeResourceModeSnapshot(value: unknown): ResourceModeSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  const mode = stringValue(record.mode);
  if (mode !== 'active' && mode !== 'idle') return null;

  return {
    enabled: booleanValue(record.enabled, true),
    mode,
    idleAfterMs: numberValue(record.idleAfterMs) ?? 0,
    sweepIntervalMs: numberValue(record.sweepIntervalMs) ?? 0,
    lastActivityAt: numberValue(record.lastActivityAt) ?? 0,
    lastActivityReason: stringValue(record.lastActivityReason) ?? 'unknown',
    idleForMs: numberValue(record.idleForMs) ?? 0,
    trimCount: numberValue(record.trimCount) ?? 0,
    lastTrimmedAt: numberOrNull(record.lastTrimmedAt),
    updatedAt: numberValue(record.updatedAt) ?? Date.now(),
  };
}

export function normalizeHubHealthSnapshot(value: unknown): Record<string, AgentHubHealth> | null {
  if (Array.isArray(value)) {
    const out: Record<string, AgentHubHealth> = {};
    for (const entry of value) {
      const health = normalizeHubHealthEntry(entry, undefined);
      if (health) out[health.agentId] = health;
    }
    return out;
  }

  const record = asRecord(value);
  if (!record) return null;

  const nestedAgents = record.agents ?? record.items ?? record.hubs;
  if (Array.isArray(nestedAgents)) return normalizeHubHealthSnapshot(nestedAgents);

  const out: Record<string, AgentHubHealth> = {};
  for (const [agentId, entry] of Object.entries(record)) {
    const health = normalizeHubHealthEntry(entry, agentId);
    if (health) out[health.agentId] = health;
  }
  return out;
}

export function normalizeAgentRuntimeEntry(value: unknown, updatedAt: number): AgentRuntimeEntry | null {
  const record = asRecord(value);
  if (!record) return null;
  const agentId = stringValue(record.agentId ?? record.agent_id ?? record.id);
  if (!agentId) return null;

  const rawStatus = stringValue(record.status ?? record.state ?? record.kind ?? record.type);
  const statusToken = rawStatus?.trim().toLowerCase();
  const running = typeof record.running === 'boolean'
    ? record.running
    : statusToken === 'running' || statusToken === 'started' || statusToken === 'agent_runtime_started';
  const status = normalizeRuntimeStatus(rawStatus, running);

  return {
    agentId,
    runtime: stringValue(record.runtime) ?? 'unknown',
    running,
    pid: numberOrNull(record.pid),
    hubPath: stringValue(record.hubPath ?? record.hub_path),
    status,
    managed: typeof record.managed === 'boolean' ? record.managed : true,
    lastError: stringValue(record.lastError ?? record.error ?? record.reason),
    updatedAt: numberValue(record.updatedAt ?? record.timestamp) ?? updatedAt,
  };
}

function runtimeAgentItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  return record ? Object.values(record) : [];
}

function normalizeRuntimeStatus(value: string | undefined, running: boolean): AgentRuntimeLifecycleStatus {
  const normalized = value?.trim().toLowerCase();
  if (normalized?.includes('start') && !normalized.includes('started')) return 'starting';
  if (normalized?.includes('stop') && !normalized.includes('stopped')) return 'stopping';
  if (normalized === 'running' || normalized === 'started' || normalized === 'agent_runtime_started') return 'running';
  if (normalized === 'stopped' || normalized === 'exited' || normalized === 'agent_runtime_stopped' || normalized === 'agent_runtime_exited') return 'stopped';
  if (normalized === 'failed' || normalized === 'error' || normalized === 'spawn_failed' || normalized === 'agent_runtime_spawn_failed') return 'failed';
  return running ? 'running' : 'stopped';
}

export function normalizeHubHealthEntry(value: unknown, fallbackAgentId: string | undefined): AgentHubHealth | null {
  const record = asRecord(value);
  if (!record) return null;
  const agentId = stringValue(record.agentId ?? record.agent_id ?? record.id) ?? fallbackAgentId;
  if (!agentId) return null;
  const status = normalizeHubHealthStatus(stringValue(record.status ?? record.health ?? record.state));

  return {
    agentId,
    status,
    dispatches: numberValue(record.dispatches),
    accepted: numberValue(record.accepted),
    running: numberValue(record.running),
    succeeded: numberValue(record.succeeded),
    failed: numberValue(record.failed),
    memories: numberValue(record.memories),
    checkedAt: numberValue(record.checkedAt ?? record.timestamp),
    lastWriteAt: numberOrNull(record.lastWriteAt ?? record.updatedAt),
    schemaVersion: stringValue(record.schemaVersion ?? record.schema_version),
    hubPath: stringValue(record.hubPath ?? record.hub_path ?? record.dbPath),
    error: stringValue(record.error ?? record.reason),
  };
}

function normalizeHubHealthStatus(value: string | undefined): AgentHubHealthStatus {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'ok' || normalized === 'healthy') return 'ok';
  if (normalized === 'stale') return 'stale';
  if (normalized === 'missing' || normalized === 'not_found') return 'missing';
  if (normalized === 'error' || normalized === 'failed') return 'error';
  return 'unknown';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
