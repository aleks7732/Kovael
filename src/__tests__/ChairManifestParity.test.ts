import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { AgentCards } from '../AgentCards.js';
import { loadChairManifests } from '../services/runtime/ChairManifestLoader.js';

// The repo-root `agent_cards/` ships a manifest for every chair. Because the
// orchestrator + supervisor prefer manifests over the compile-time AgentCards
// fallback, the manifests MUST reproduce AgentCards byte-for-byte (minus the
// new `runtime` block) or the roster/specs silently drift. This test is the
// guard that keeps the two sources in sync.
const cardsDir = fileURLToPath(new URL('../../agent_cards', import.meta.url));

describe('agent_cards manifests ↔ AgentCards parity', () => {
  const result = loadChairManifests(cardsDir);

  it('loads from manifests (not the fallback)', () => {
    expect(result.source).toBe('manifests');
    expect(result.errors).toEqual([]);
  });

  it('covers exactly the 9 known chairs', () => {
    expect(result.cards.length).toBe(Object.keys(AgentCards).length);
    expect(new Set(result.cards.map((c) => c.id))).toEqual(new Set(Object.keys(AgentCards)));
  });

  it('reproduces every AgentCard field (runtime aside)', () => {
    const byId = Object.fromEntries(result.cards.map((c) => [c.id, c]));
    for (const [id, expected] of Object.entries(AgentCards)) {
      const got = byId[id];
      expect(got, `missing manifest card for ${id}`).toBeTruthy();
      const { runtime: _runtime, ...gotNoRuntime } = got;
      expect(gotNoRuntime, `field drift for ${id}`).toEqual(expected);
    }
  });

  it('declares the expected runtime kinds', () => {
    const kindFor = (id: string) => result.cards.find((c) => c.id === id)?.runtime?.kind;
    expect(kindFor('shaev')).toBe('claude-shaev');
    expect(kindFor('nyx-codex')).toBe('codex');
    expect(kindFor('nyx-openclaw')).toBe('codex-openclaw');
    expect(kindFor('nyx-adk')).toBe('command');
    expect(kindFor('nyx-cw')).toBe('command');
    // presence-only chairs carry no runtime
    for (const id of ['nyx-antigravity', 'nyx-claude-code', 'nyx-cli', 'nyx-agcli']) {
      expect(kindFor(id), `${id} should be presence-only`).toBeUndefined();
    }
  });
});
