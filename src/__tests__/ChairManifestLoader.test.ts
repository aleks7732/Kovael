import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadChairManifests } from '../services/runtime/ChairManifestLoader.js';

let dir: string | null = null;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = null; });

function tmp(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kovael-cards-'));
  return dir;
}

describe('loadChairManifests', () => {
  it('falls back to built-in cards when the dir is absent', () => {
    const res = loadChairManifests(path.join(os.tmpdir(), 'does-not-exist-xyz-kovael'));
    expect(res.source).toBe('fallback');
    expect(res.cards.length).toBeGreaterThan(0);
  });
  it('loads + validates JSON manifests when present', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'nyx-x.json'), JSON.stringify({
      id: 'nyx-x', name: 'Nyx X', provider: 'P', trustTier: 2,
    }));
    const res = loadChairManifests(d);
    expect(res.source).toBe('manifests');
    expect(res.cards.find((c) => c.id === 'nyx-x')).toBeTruthy();
    expect(res.errors).toEqual([]);
  });
  it('reports an error for an invalid manifest and keeps the rest', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'bad.json'), JSON.stringify({ name: 'no id' }));
    const res = loadChairManifests(d);
    expect(res.errors.length).toBe(1);
  });
});
