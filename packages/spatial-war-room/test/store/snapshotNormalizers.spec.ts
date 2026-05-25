import { describe, expect, it } from 'vitest';
import {
  normalizeAgentRuntimeSnapshot,
  normalizeHubHealthSnapshot,
  normalizeResourceModeSnapshot,
} from '../../src/store/snapshotNormalizers';

describe('snapshot normalizers', () => {
  it('normalizes runtime snapshots from keyed agent objects and event aliases', () => {
    const snapshot = normalizeAgentRuntimeSnapshot({
      enabled: true,
      park_on_idle: false,
      agents: {
        shaev: {
          agent_id: 'shaev',
          runtime: 'claude-shaev',
          state: 'agent_runtime_spawn_failed',
          error: 'spawn failed',
          updatedAt: 1779733000000,
        },
        'nyx-codex': {
          id: 'nyx-codex',
          runtime: 'codex',
          status: ' Started ',
          pid: 42,
        },
      },
    });

    expect(snapshot).toMatchObject({
      enabled: true,
      parkOnIdle: false,
      configured: 2,
      running: 1,
    });
    expect(snapshot?.agents.shaev).toMatchObject({
      agentId: 'shaev',
      status: 'failed',
      running: false,
      lastError: 'spawn failed',
    });
    expect(snapshot?.agents['nyx-codex']).toMatchObject({
      agentId: 'nyx-codex',
      status: 'running',
      running: true,
      pid: 42,
    });
  });

  it('normalizes hub health snapshots from nested arrays and snake_case fields', () => {
    const snapshot = normalizeHubHealthSnapshot({
      hubs: [
        {
          agent_id: 'shaev',
          health: 'healthy',
          schema_version: '2',
          hub_path: 'I:\\Kovael\\.kovael\\agents\\shaev\\agent-hub.sqlite',
          lastWriteAt: 1779733010000,
        },
        {
          id: 'nyx-codex',
          state: 'not_found',
          reason: 'missing hub',
        },
      ],
    });

    expect(snapshot?.shaev).toMatchObject({
      agentId: 'shaev',
      status: 'ok',
      schemaVersion: '2',
      hubPath: 'I:\\Kovael\\.kovael\\agents\\shaev\\agent-hub.sqlite',
      lastWriteAt: 1779733010000,
    });
    expect(snapshot?.['nyx-codex']).toMatchObject({
      agentId: 'nyx-codex',
      status: 'missing',
      error: 'missing hub',
    });
  });

  it('normalizes resource mode defaults and rejects invalid modes', () => {
    expect(normalizeResourceModeSnapshot({ mode: 'sleeping' })).toBeNull();
    expect(normalizeResourceModeSnapshot({
      mode: 'idle',
      enabled: false,
      idleAfterMs: 600000,
      lastTrimmedAt: 1779733020000,
    })).toMatchObject({
      enabled: false,
      mode: 'idle',
      idleAfterMs: 600000,
      sweepIntervalMs: 0,
      lastActivityReason: 'unknown',
      lastTrimmedAt: 1779733020000,
    });
  });
});
