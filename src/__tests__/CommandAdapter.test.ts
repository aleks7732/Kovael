import { describe, it, expect } from 'vitest';
import {
  commandAdapter,
  isCommandAllowed,
  parseCommandAllowList,
  COMMAND_ADAPTER_ALLOW_ENV,
} from '../services/runtime/CommandAdapter.js';
import { defaultRuntimeRegistry } from '../services/runtime/builtinAdapters.js';
import type { AgentCard } from '../AgentCards.js';

const cmdCard: AgentCard = {
  id: 'nyx-test',
  name: 'Nyx Test',
  provider: 'P',
  description: '',
  mcp_capabilities: ['x'],
  vram_requirements: '0GB',
  trust_tier: 2,
  runtime: { kind: 'command', supervised: true, command: 'python', args: ['-m', 'm'], allowEnv: ['KOVAEL_HOST'] },
};

describe('CommandAdapter', () => {
  it('registers the command kind on the default registry', () => {
    expect(defaultRuntimeRegistry().resolve('command')).toBeTruthy();
    expect(commandAdapter.kind).toBe('command');
    expect(commandAdapter.supervised).toBe(true);
  });

  it('buildSpec carries command/args/allowEnv from the card runtime', () => {
    const spec = commandAdapter.buildSpec(cmdCard);
    expect(spec.runtime).toBe('command');
    expect(spec.agentId).toBe('nyx-test');
    expect(spec.command).toBe('python');
    expect(spec.args).toEqual(['-m', 'm']);
    expect(spec.allowEnv).toEqual(['KOVAEL_HOST']);
    expect(spec.capabilities).toEqual(['x']);
    expect(spec.trustTier).toBe(2);
  });

  it('is disabled by default (empty / unset allow-list)', () => {
    expect(parseCommandAllowList({})).toEqual([]);
    expect(isCommandAllowed('python', {})).toBe(false);
  });

  it('honours the binary allow-list', () => {
    const env = { [COMMAND_ADAPTER_ALLOW_ENV]: 'python, node' } as NodeJS.ProcessEnv;
    expect(parseCommandAllowList(env)).toEqual(['python', 'node']);
    expect(isCommandAllowed('python', env)).toBe(true);
    expect(isCommandAllowed('rm', env)).toBe(false);
    expect(isCommandAllowed(undefined, env)).toBe(false);
  });

  it('buildSpec on a runtime-less card yields no command (fail-safe to blocked)', () => {
    const bare: AgentCard = {
      id: 'x', name: 'x', provider: 'p', description: '',
      mcp_capabilities: [], vram_requirements: '0', trust_tier: 1,
    };
    expect(commandAdapter.buildSpec(bare).command).toBeUndefined();
  });
});
