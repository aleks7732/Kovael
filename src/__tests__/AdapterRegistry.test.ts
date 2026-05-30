import { describe, it, expect } from 'vitest';
import { AdapterRegistry, type RuntimeAdapter } from '../services/runtime/AdapterRegistry.js';

const stub: RuntimeAdapter = {
  kind: 'stub',
  supervised: true,
  buildSpec: (card) => ({ agentId: card.id, provider: card.provider, runtime: 'stub' }),
  policy: () => ({ sandboxMode: null, permissionMode: null, allowedTools: null, sessionPersistence: null }),
  resolveExecutable: () => 'stub-bin',
};

describe('AdapterRegistry', () => {
  it('registers and resolves an adapter by kind', () => {
    const reg = new AdapterRegistry();
    reg.register(stub);
    expect(reg.resolve('stub')).toBe(stub);
    expect(reg.kinds()).toEqual(['stub']);
  });

  it('returns undefined for an unknown kind', () => {
    const reg = new AdapterRegistry();
    expect(reg.resolve('nope')).toBeUndefined();
  });
});
