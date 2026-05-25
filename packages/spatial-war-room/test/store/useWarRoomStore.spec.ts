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
});
