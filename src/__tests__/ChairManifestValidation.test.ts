import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest } from '../services/runtime/ChairManifest.js';
import { defaultRuntimeRegistry } from '../services/runtime/builtinAdapters.js';

// CI-enforced manifest lint (runs under the vitest / linux-verify jobs). A bad,
// unresolvable, or persona-orphaned manifest fails the PR here — not in prod.
const cardsDir = fileURLToPath(new URL('../../agent_cards', import.meta.url));
const personasDir = fileURLToPath(new URL('../../personas', import.meta.url));

function personaAgentId(id: string): string | null {
  const p = path.join(personasDir, `${id}.md`);
  if (!fs.existsSync(p)) return null;
  const m = fs.readFileSync(p, 'utf-8').match(/^agent_id:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

const files = fs.readdirSync(cardsDir).filter((f) => f.endsWith('.json'));
const registry = defaultRuntimeRegistry();

describe('agent_cards manifest lint (PR gate)', () => {
  it('ships a manifest for every known chair', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  for (const file of files) {
    describe(file, () => {
      const raw = JSON.parse(fs.readFileSync(path.join(cardsDir, file), 'utf-8'));
      const parsed = parseManifest(raw);

      it('schema-validates', () => {
        expect(parsed.ok ? '' : parsed.error).toBe('');
      });

      it('resolves its runtime.kind and pairs with a matching persona', () => {
        if (!parsed.ok) throw new Error('manifest failed schema; see schema-validates');
        const m = parsed.manifest;
        if (m.runtime) {
          expect(registry.resolve(m.runtime.kind), `unknown runtime.kind '${m.runtime.kind}'`).toBeTruthy();
        }
        expect(personaAgentId(m.id), `persona agent_id mismatch for '${m.id}'`).toBe(m.id);
        expect(path.basename(file, '.json')).toBe(m.id); // filename ↔ id
      });
    });
  }
});
