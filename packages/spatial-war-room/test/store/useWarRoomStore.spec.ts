import { afterEach, describe, expect, it } from 'vitest';
import { useWarRoomStore } from '../../src/store/useWarRoomStore';

afterEach(() => {
  useWarRoomStore.setState({
    agentRuntimes: null,
    resourceMode: null,
    hubHealthByAgent: {},
    pendingLifecycleActions: {},
    lifecycleErrors: {},
  } as any);
});

describe('useWarRoomStore lifecycle snapshots', () => {
  it('ingests runtime, resource mode, and hub health from a state snapshot', () => {
    useWarRoomStore.getState().applyStateSnapshot({
      agentRuntimes: {
        enabled: true,
        parkOnIdle: true,
        configured: 1,
        running: 1,
        agents: [
          {
            agentId: 'shaev',
            runtime: 'claude-shaev',
            running: true,
            pid: 4242,
            hubPath: 'I:\\Kovael\\.kovael\\agents\\shaev\\agent-hub.sqlite',
          },
        ],
      },
      resourceMode: {
        enabled: true,
        mode: 'idle',
        idleAfterMs: 600000,
        sweepIntervalMs: 5000,
        lastActivityAt: 1779262000000,
        lastActivityReason: 'test',
        idleForMs: 12000,
        trimCount: 2,
        lastTrimmedAt: 1779262012000,
      },
      hubHealthByAgent: {
        shaev: {
          agentId: 'shaev',
          status: 'ok',
          dispatches: 3,
          running: 1,
          succeeded: 2,
          failed: 0,
          memories: 4,
          checkedAt: 1779262020000,
        },
      },
    });

    const state = useWarRoomStore.getState();
    expect(state.agentRuntimes?.enabled).toBe(true);
    expect(state.agentRuntimes?.agents.shaev).toMatchObject({
      agentId: 'shaev',
      runtime: 'claude-shaev',
      running: true,
      pid: 4242,
      status: 'running',
      managed: true,
    });
    expect(state.resourceMode?.mode).toBe('idle');
    expect(state.hubHealthByAgent.shaev).toMatchObject({
      status: 'ok',
      dispatches: 3,
      memories: 4,
    });
  });

  it('tracks pending lifecycle actions and clears errors on a new action', () => {
    const store = useWarRoomStore.getState();

    store.recordLifecycleError('shaev', 'spawn failed');
    expect(useWarRoomStore.getState().lifecycleErrors.shaev).toBe('spawn failed');

    store.setLifecyclePending('shaev', 'restart');
    expect(useWarRoomStore.getState().pendingLifecycleActions.shaev).toBe('restart');
    expect(useWarRoomStore.getState().lifecycleErrors.shaev).toBeUndefined();

    store.clearLifecyclePending('shaev');
    expect(useWarRoomStore.getState().pendingLifecycleActions.shaev).toBeUndefined();
  });

  it('normalizes runtime lifecycle events and clears pending actions', () => {
    const store = useWarRoomStore.getState();

    store.setLifecyclePending('shaev', 'restart');
    store.recordLifecycleError('shaev', 'old error');
    store.recordAgentRuntimeEvent({
      agent_id: 'shaev',
      runtime: 'claude-shaev',
      type: 'agent_runtime_spawn_failed',
      hub_path: 'hub.sqlite',
      reason: 'spawn failed',
      timestamp: 1779733030000,
    });

    const state = useWarRoomStore.getState();
    expect(state.agentRuntimes?.agents.shaev).toMatchObject({
      agentId: 'shaev',
      runtime: 'claude-shaev',
      status: 'failed',
      running: false,
      hubPath: 'hub.sqlite',
      lastError: 'spawn failed',
      updatedAt: 1779733030000,
    });
    expect(state.lifecycleErrors.shaev).toBe('spawn failed');
    expect(state.pendingLifecycleActions.shaev).toBeUndefined();
  });

  it('normalizes hub health aliases with fallback agent ids', () => {
    useWarRoomStore.getState().applyStateSnapshot({
      agentHubs: {
        shaev: {
          health: 'not_found',
          dispatches: 2,
          dbPath: 'hub.sqlite',
          updatedAt: null,
        },
      },
    });

    expect(useWarRoomStore.getState().hubHealthByAgent.shaev).toMatchObject({
      agentId: 'shaev',
      status: 'missing',
      dispatches: 2,
      hubPath: 'hub.sqlite',
      lastWriteAt: null,
    });
  });

  it('ignores invalid snapshots without clearing existing state', () => {
    const store = useWarRoomStore.getState();
    store.setResourceModeSnapshot({ mode: 'idle' });
    const before = useWarRoomStore.getState().resourceMode;

    store.setResourceModeSnapshot({ mode: 'bad' });
    store.applyHubHealthSnapshot(null);

    expect(useWarRoomStore.getState().resourceMode).toBe(before);
  });
});
