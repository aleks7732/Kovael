import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultAgentRuntimeSpecs } from '../services/AgentRuntimeSupervisor.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

let tmp: string | null = null;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function tmpCwdWith(manifests: Record<string, unknown>): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kovael-chairs-'));
  const dir = path.join(tmp, 'agent_cards');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, m] of Object.entries(manifests)) {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(m));
  }
  return tmp;
}

describe('manifest-driven supervision', () => {
  it('derives the built-in supervised specs from repo manifests, blocking elevated by default', () => {
    const specs = defaultAgentRuntimeSpecs(['shaev', 'nyx-codex', 'nyx-openclaw'], { cwd: repoRoot });
    const byId = Object.fromEntries(specs.map((s) => [s.agentId, s]));
    expect(byId['shaev']?.runtime).toBe('claude-shaev');
    expect(byId['nyx-codex']?.runtime).toBe('codex');
    expect(byId['nyx-openclaw']).toBeUndefined(); // elevated, blocked unless opted in
  });

  it('admits nyx-openclaw when elevated runtimes are enabled', () => {
    const specs = defaultAgentRuntimeSpecs(['nyx-openclaw'], { cwd: repoRoot, enableElevated: true });
    expect(specs[0]?.runtime).toBe('codex-openclaw');
  });

  // Acceptance criterion #1: a brand-new dispatch-capable chair on an existing
  // runtime kind (`command`) becomes a supervisable spec with ONLY a manifest —
  // zero `src/` edits.
  it('connects a 10th command chair from a manifest alone (allow-listed)', () => {
    const cwd = tmpCwdWith({
      'nyx-tenth': {
        id: 'nyx-tenth', name: 'Nyx Tenth', provider: 'Local · Example',
        trustTier: 2, capabilities: ['x'], vram: '0GB',
        runtime: { kind: 'command', supervised: true, command: 'node', args: ['-e', 'process.stdout.write("hi")'], allowEnv: ['KOVAEL_HOST'] },
      },
    });
    const specs = defaultAgentRuntimeSpecs(['nyx-tenth'], {
      cwd, env: { KOVAEL_COMMAND_ADAPTER_ALLOW: 'node' } as NodeJS.ProcessEnv,
    });
    expect(specs.length).toBe(1);
    const spec = specs[0];
    expect(spec.agentId).toBe('nyx-tenth');
    expect(spec.runtime).toBe('command');
    expect(spec.command).toBe('node');
    expect(spec.args).toEqual(['-e', 'process.stdout.write("hi")']);
    expect(spec.allowEnv).toEqual(['KOVAEL_HOST']);
    expect(spec.enabled).not.toBe(false);
  });

  it('disables a command chair whose binary is not allow-listed (secure default)', () => {
    const cwd = tmpCwdWith({
      'nyx-tenth': {
        id: 'nyx-tenth', name: 'Nyx Tenth', provider: 'Local · Example',
        trustTier: 2, capabilities: ['x'], vram: '0GB',
        runtime: { kind: 'command', supervised: true, command: 'rm', args: ['-rf', '/'] },
      },
    });
    const specs = defaultAgentRuntimeSpecs(['nyx-tenth'], { cwd, env: {} as NodeJS.ProcessEnv });
    expect(specs.length).toBe(1);
    expect(specs[0].enabled).toBe(false);
  });
});
