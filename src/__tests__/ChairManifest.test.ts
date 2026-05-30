import { describe, it, expect } from 'vitest';
import { parseManifest } from '../services/runtime/ChairManifest.js';

const valid = {
  id: 'nyx-adk', name: 'Nyx ADK', provider: 'Google · ADK',
  trustTier: 2, capabilities: ['python'], vram: 'cloud',
};

describe('parseManifest', () => {
  it('accepts a minimal valid manifest', () => {
    expect(parseManifest(valid).ok).toBe(true);
  });
  it('rejects a manifest missing id', () => {
    expect(parseManifest({ ...valid, id: undefined }).ok).toBe(false);
  });
  it('rejects a non-numeric trustTier', () => {
    expect(parseManifest({ ...valid, trustTier: 'high' }).ok).toBe(false);
  });
});
