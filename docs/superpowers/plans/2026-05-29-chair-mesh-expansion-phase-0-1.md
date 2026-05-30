# Open Chair Mesh — Phase 0 + Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-hardcode Kovael's runtime lifecycle so a chair's runtime is resolved through a pluggable adapter registry and chairs are declared by validated manifests — with byte-for-byte behavior for today's 3 supervised chairs.

**Architecture:** Introduce a `RuntimeAdapter` interface + `AdapterRegistry`; lift the existing `byId`/`runtimePolicyFor`/`runtimeExecutablePathFor` logic verbatim into three built-in adapters (`codex`, `codex-openclaw`, `claude-shaev`); widen `AgentRuntimeSpec.runtime` from a closed union to a `string` kind resolved via the registry. Harden the existing `agent_cards/*.json` loader with a `zod` schema. No new external dependencies (`zod` is already in-tree).

**Tech Stack:** Node 22, TypeScript, Vitest, `zod` (already a dependency), `node:sqlite`.

**Source spec:** [`docs/superpowers/specs/2026-05-29-chair-mesh-expansion-design.md`](../specs/2026-05-29-chair-mesh-expansion-design.md). This plan covers **Phase 0 + Phase 1 only**. Phase 2 (connect-all adapters incl. the gated `CommandAdapter`) and Phase 3 (bloat remediation) get their own plans after Phase 1 locks the `RuntimeAdapter` interface.

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `.gitattributes` | Force LF for `*.sh`/`*.mjs`/`*.ts`; cross-platform line-ending floor | Create |
| `.github/workflows/ci.yml` | Add a Linux Node-22 `tsc` + Vitest gate | Modify |
| `src/services/runtime/AdapterRegistry.ts` | `RuntimeAdapter` interface + `AdapterRegistry` map | Create |
| `src/services/runtime/builtinAdapters.ts` | The 3 built-in adapters + a default registry | Create |
| `src/services/runtime/ChairManifest.ts` | `zod` manifest schema + `parseManifest` | Create |
| `src/services/runtime/ChairManifestLoader.ts` | Validated `agent_cards/*.json` loader + fallback | Create |
| `src/services/AgentRuntimeSupervisor.ts` | Widen `runtime` to `string`; delegate spec/policy/exe to registry | Modify |
| `src/MeshOrchestrator.ts` | Use `ChairManifestLoader` instead of inline `loadAgentCards` | Modify |
| `src/__tests__/AdapterRegistry.test.ts` | Registry unit tests | Create |
| `src/__tests__/BuiltinAdapters.test.ts` | Behavior-parity tests for the 3 adapters | Create |
| `src/__tests__/ChairManifest.test.ts` | Schema validation tests | Create |
| `src/__tests__/ChairManifestLoader.test.ts` | Loader + fallback tests | Create |

---

## Phase 0 — Hygiene & Truth

### Task 0.1: Add `.gitattributes` line-ending floor

**Files:**
- Create: `.gitattributes`

- [ ] **Step 1: Create `.gitattributes`**

```gitattributes
# Normalize all text to LF in the repo; tools convert on checkout if needed.
* text=auto eol=lf

# Shell scripts MUST stay LF or they break under bash on Linux.
*.sh text eol=lf
*.mjs text eol=lf

# Binary assets — never touch.
*.png binary
*.svg -text
```

- [ ] **Step 2: Renormalize and verify the index is LF**

Run:
```bash
git add --renormalize .
git ls-files --eol -- "*.sh" "*.mjs" | head
```
Expected: every line shows `i/lf` (index is LF). Working-tree `w/` may be `crlf` on Windows — that is correct.

- [ ] **Step 3: Commit**

```bash
git add .gitattributes
git commit -m "build: add .gitattributes to pin LF line endings"
```

---

### Task 0.2: Add a Linux build+test CI gate

**Files:**
- Modify: `.github/workflows/ci.yml` (add one job under the existing `jobs:` map — do **not** duplicate the top-level `name:`/`on:` keys)

- [ ] **Step 1: Add the `linux-verify` job**

Append this job under `jobs:` in `.github/workflows/ci.yml`:

```yaml
  linux-verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm test
```

- [ ] **Step 2: Validate the workflow parses**

Run:
```bash
node scripts/lint-k8s-manifests.mjs >/dev/null 2>&1 || true
npx --yes js-yaml .github/workflows/ci.yml >/dev/null && echo "YAML OK"
```
Expected: `YAML OK` (no parse error).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: gate on Node 22 Linux build + test"
```

---

## Phase 1 — Registry Foundation

### Task 1.1: `RuntimeAdapter` interface + `AdapterRegistry`

**Files:**
- Create: `src/services/runtime/AdapterRegistry.ts`
- Test: `src/__tests__/AdapterRegistry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/AdapterRegistry.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/AdapterRegistry.test.ts`
Expected: FAIL — cannot find module `AdapterRegistry.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/services/runtime/AdapterRegistry.ts
import type { AgentCard } from '../../AgentCards.js';

export interface RuntimeSpecDraft {
  agentId: string;
  provider: string;
  runtime: string;
  capabilities?: string[];
  trustTier?: number;
  cwd?: string;
  model?: string;
}

export interface RuntimePolicy {
  sandboxMode: string | null;
  permissionMode: string | null;
  allowedTools: string[] | null;
  sessionPersistence: boolean | null;
}

export interface RuntimeAdapter {
  readonly kind: string;
  readonly supervised: boolean;
  buildSpec(card: AgentCard): RuntimeSpecDraft;
  policy(): RuntimePolicy;
  resolveExecutable(env: NodeJS.ProcessEnv): string;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>();
  register(adapter: RuntimeAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }
  resolve(kind: string): RuntimeAdapter | undefined {
    return this.adapters.get(kind);
  }
  kinds(): string[] {
    return [...this.adapters.keys()];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/AdapterRegistry.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/runtime/AdapterRegistry.ts src/__tests__/AdapterRegistry.test.ts
git commit -m "feat(runtime): add RuntimeAdapter interface and AdapterRegistry"
```

---

### Task 1.2: Built-in adapters (behavior parity)

**Files:**
- Create: `src/services/runtime/builtinAdapters.ts`
- Test: `src/__tests__/BuiltinAdapters.test.ts`

> The adapter bodies are lifted verbatim from the current `defaultAgentRuntimeSpecs` ([AgentRuntimeSupervisor.ts:707](../../../src/services/AgentRuntimeSupervisor.ts)), `runtimePolicyFor` ([:753](../../../src/services/AgentRuntimeSupervisor.ts)), and `runtimeExecutablePathFor` ([:781](../../../src/services/AgentRuntimeSupervisor.ts)). Parity is the whole point.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/BuiltinAdapters.test.ts
import { describe, it, expect } from 'vitest';
import { defaultRuntimeRegistry } from '../services/runtime/builtinAdapters.js';
import { AgentCards } from '../AgentCards.js';

describe('builtin adapters', () => {
  it('registers exactly the three known kinds', () => {
    expect(defaultRuntimeRegistry().kinds().sort())
      .toEqual(['claude-shaev', 'codex', 'codex-openclaw']);
  });

  it('codex adapter reproduces the current nyx-codex spec', () => {
    const spec = defaultRuntimeRegistry().resolve('codex')!.buildSpec(AgentCards['nyx-codex']);
    expect(spec).toEqual({
      agentId: 'nyx-codex',
      provider: AgentCards['nyx-codex'].provider,
      runtime: 'codex',
      capabilities: AgentCards['nyx-codex'].mcp_capabilities,
      trustTier: AgentCards['nyx-codex'].trust_tier,
    });
  });

  it('codex policy is read-only; claude-shaev policy is dontAsk', () => {
    const reg = defaultRuntimeRegistry();
    expect(reg.resolve('codex')!.policy().sandboxMode).toBe('read-only');
    expect(reg.resolve('codex-openclaw')!.policy().sandboxMode).toBe('danger-full-access');
    expect(reg.resolve('claude-shaev')!.policy().permissionMode).toBe('dontAsk');
  });

  it('resolveExecutable honors env overrides', () => {
    const reg = defaultRuntimeRegistry();
    expect(reg.resolve('claude-shaev')!.resolveExecutable({ KOVAEL_CLAUDE_BIN: '/x/claude' } as NodeJS.ProcessEnv)).toBe('/x/claude');
    expect(reg.resolve('codex')!.resolveExecutable({ KOVAEL_CODEX_BIN: '/x/codex' } as NodeJS.ProcessEnv)).toBe('/x/codex');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/BuiltinAdapters.test.ts`
Expected: FAIL — cannot find module `builtinAdapters.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/services/runtime/builtinAdapters.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentCard } from '../../AgentCards.js';
import { AdapterRegistry, type RuntimeAdapter, type RuntimePolicy, type RuntimeSpecDraft } from './AdapterRegistry.js';

function specFrom(card: AgentCard, runtime: string): RuntimeSpecDraft {
  return {
    agentId: card.id,
    provider: card.provider,
    runtime,
    capabilities: card.mcp_capabilities,
    trustTier: card.trust_tier,
  };
}

const codexAdapter: RuntimeAdapter = {
  kind: 'codex',
  supervised: true,
  buildSpec: (card) => specFrom(card, 'codex'),
  policy: (): RuntimePolicy => ({ sandboxMode: 'read-only', permissionMode: null, allowedTools: null, sessionPersistence: null }),
  resolveExecutable: (env) => {
    if (env.KOVAEL_CODEX_BIN) return env.KOVAEL_CODEX_BIN;
    if (process.platform === 'win32') {
      const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      const script = path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (fs.existsSync(script)) return script;
    }
    return 'codex';
  },
};

const openclawAdapter: RuntimeAdapter = {
  kind: 'codex-openclaw',
  supervised: true,
  buildSpec: (card) => specFrom(card, 'codex-openclaw'),
  policy: (): RuntimePolicy => ({ sandboxMode: 'danger-full-access', permissionMode: null, allowedTools: null, sessionPersistence: null }),
  resolveExecutable: codexAdapter.resolveExecutable,
};

const shaevAdapter: RuntimeAdapter = {
  kind: 'claude-shaev',
  supervised: true,
  buildSpec: (card) => specFrom(card, 'claude-shaev'),
  policy: (): RuntimePolicy => ({ sandboxMode: null, permissionMode: 'dontAsk', allowedTools: [], sessionPersistence: false }),
  resolveExecutable: (env) => env.KOVAEL_CLAUDE_BIN || (process.platform === 'win32' ? 'claude.exe' : 'claude'),
};

export const BUILTIN_ADAPTERS: RuntimeAdapter[] = [codexAdapter, openclawAdapter, shaevAdapter];

export function defaultRuntimeRegistry(): AdapterRegistry {
  const reg = new AdapterRegistry();
  for (const adapter of BUILTIN_ADAPTERS) reg.register(adapter);
  return reg;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/BuiltinAdapters.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/runtime/builtinAdapters.ts src/__tests__/BuiltinAdapters.test.ts
git commit -m "feat(runtime): add built-in codex/openclaw/shaev adapters"
```

---

### Task 1.3: Delegate the supervisor to the registry

**Files:**
- Modify: `src/services/AgentRuntimeSupervisor.ts` (interface L29; `defaultAgentRuntimeSpecs` L703; `runtimePolicyFor` L753; `runtimeExecutablePathFor` L781)
- Test: existing `src/__tests__/AgentRuntimeSupervisor.test.ts` must stay green

- [ ] **Step 1: Widen the `runtime` type**

In `AgentRuntimeSpec` (L29), change:
```ts
    runtime: 'codex' | 'codex-openclaw' | 'claude-shaev';
```
to:
```ts
    runtime: string;
```

- [ ] **Step 2a: Add the registry import at the top of the file**

`AgentCards` is already imported (L7). Add only this near the other imports:
```ts
import { defaultRuntimeRegistry } from './runtime/builtinAdapters.js';
```

- [ ] **Step 2b: Replace `defaultAgentRuntimeSpecs` to build from the registry**

Replace the body (L703–733) with (no import lines inside the function):
```ts
const BUILTIN_AGENT_KINDS: Record<string, string> = {
  shaev: 'claude-shaev',
  'nyx-codex': 'codex',
  'nyx-openclaw': 'codex-openclaw',
};

function defaultAgentRuntimeSpecs(
  ids: readonly string[] = DEFAULT_AGENT_IDS,
  options: { enableElevated?: boolean } = {},
): AgentRuntimeSpec[] {
  const registry = defaultRuntimeRegistry();
  const elevated = new Set(options.enableElevated ? [] : ['nyx-openclaw']);
  return ids
    .filter((id) => !elevated.has(id))
    .map((id) => {
      const kind = BUILTIN_AGENT_KINDS[id];
      const card = AgentCards[id];
      const adapter = kind ? registry.resolve(kind) : undefined;
      if (!adapter || !card) return undefined;
      return adapter.buildSpec(card) as AgentRuntimeSpec;
    })
    .filter((spec): spec is AgentRuntimeSpec => spec !== undefined);
}
```

- [ ] **Step 3: Delegate `runtimePolicyFor` and `runtimeExecutablePathFor`**

Replace both functions (L753–793) with registry delegations that preserve the claude-shaev default fallback:
```ts
function runtimePolicyFor(runtime: string): Pick<
  AgentRuntimePreflightSummary,
  'sandboxMode' | 'permissionMode' | 'allowedTools' | 'sessionPersistence'
> {
  const adapter = defaultRuntimeRegistry().resolve(runtime);
  if (adapter) return adapter.policy();
  return { sandboxMode: null, permissionMode: 'dontAsk', allowedTools: [], sessionPersistence: false };
}

function runtimeExecutablePathFor(runtime: string, env: NodeJS.ProcessEnv): string {
  const adapter = defaultRuntimeRegistry().resolve(runtime);
  if (adapter) return adapter.resolveExecutable(env);
  return runtime;
}
```

- [ ] **Step 4: Run the full supervisor suite to verify parity**

Run: `npx vitest run src/__tests__/AgentRuntimeSupervisor.test.ts`
Expected: PASS — same count as before this task (no behavior change for the 3 known kinds).

- [ ] **Step 5: Run the whole suite + build**

Run: `npm run build && npm test`
Expected: `tsc` exit 0; all tests pass (was 555 — must not drop).

- [ ] **Step 6: Commit**

```bash
git add src/services/AgentRuntimeSupervisor.ts
git commit -m "refactor(runtime): resolve runtime kind via AdapterRegistry"
```

---

### Task 1.4: Chair manifest `zod` schema

**Files:**
- Create: `src/services/runtime/ChairManifest.ts`
- Test: `src/__tests__/ChairManifest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/ChairManifest.test.ts
import { describe, it, expect } from 'vitest';
import { parseManifest } from '../services/runtime/ChairManifest.js';

const valid = {
  id: 'nyx-adk', name: 'Nyx ADK', provider: 'Google · ADK',
  trustTier: 2, capabilities: ['python'], vram: 'cloud',
};

describe('parseManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const m = parseManifest(valid);
    expect(m.ok).toBe(true);
  });

  it('rejects a manifest missing id', () => {
    const m = parseManifest({ ...valid, id: undefined });
    expect(m.ok).toBe(false);
  });

  it('rejects a non-numeric trustTier', () => {
    const m = parseManifest({ ...valid, trustTier: 'high' });
    expect(m.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/ChairManifest.test.ts`
Expected: FAIL — cannot find module `ChairManifest.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/services/runtime/ChairManifest.ts
import { z } from 'zod';

export const ChairRuntimeSchema = z.object({
  kind: z.string().min(1),
  supervised: z.boolean().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  allowEnv: z.array(z.string()).optional(),
  elevated: z.boolean().optional(),
});

export const ChairManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  trustTier: z.number().int(),
  capabilities: z.array(z.string()).default([]),
  vram: z.string().default('unknown'),
  portrait: z.string().optional(),
  runtime: ChairRuntimeSchema.optional(),
});

export type ChairManifest = z.infer<typeof ChairManifestSchema>;

export type ParseResult =
  | { ok: true; manifest: ChairManifest }
  | { ok: false; error: string };

export function parseManifest(input: unknown): ParseResult {
  const result = ChairManifestSchema.safeParse(input);
  if (result.success) return { ok: true, manifest: result.data };
  return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/ChairManifest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/runtime/ChairManifest.ts src/__tests__/ChairManifest.test.ts
git commit -m "feat(runtime): add zod chair manifest schema"
```

---

### Task 1.5: `ChairManifestLoader` + wire MeshOrchestrator

**Files:**
- Create: `src/services/runtime/ChairManifestLoader.ts`
- Modify: `src/MeshOrchestrator.ts` (`loadAgentCards` L581–598)
- Test: `src/__tests__/ChairManifestLoader.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/ChairManifestLoader.test.ts
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
    const res = loadChairManifests(path.join(os.tmpdir(), 'does-not-exist-xyz'));
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/ChairManifestLoader.test.ts`
Expected: FAIL — cannot find module `ChairManifestLoader.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/services/runtime/ChairManifestLoader.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentCards, type AgentCard } from '../../AgentCards.js';
import { parseManifest, type ChairManifest } from './ChairManifest.js';

export interface ManifestLoadResult {
  source: 'manifests' | 'fallback';
  cards: AgentCard[];
  manifests: ChairManifest[];
  errors: string[];
}

function manifestToCard(m: ChairManifest): AgentCard {
  return {
    id: m.id,
    name: m.name,
    provider: m.provider,
    description: '',
    mcp_capabilities: m.capabilities,
    vram_requirements: m.vram,
    trust_tier: m.trustTier,
    portrait_url: m.portrait ? `/agents/${m.portrait}` : undefined,
  };
}

export function loadChairManifests(cardsDir: string): ManifestLoadResult {
  const errors: string[] = [];
  const manifests: ChairManifest[] = [];
  if (fs.existsSync(cardsDir)) {
    for (const f of fs.readdirSync(cardsDir).filter((x) => x.endsWith('.json'))) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(cardsDir, f), 'utf-8'));
        const parsed = parseManifest(raw);
        if (parsed.ok) manifests.push(parsed.manifest);
        else errors.push(`${f}: ${parsed.error}`);
      } catch (e) {
        errors.push(`${f}: ${(e as Error).message}`);
      }
    }
  }
  if (manifests.length > 0) {
    return { source: 'manifests', cards: manifests.map(manifestToCard), manifests, errors };
  }
  return { source: 'fallback', cards: Object.values(AgentCards), manifests: [], errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/ChairManifestLoader.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire MeshOrchestrator to the loader**

Replace `loadAgentCards` (L581–598) with:
```ts
    private loadAgentCards() {
        const cardsDir = path.join(process.cwd(), 'agent_cards');
        const result = loadChairManifests(cardsDir);
        this.agentCards = result.cards;
        for (const err of result.errors) this.log.warn('agent_cards_invalid', { error: err });
        this.log.info(result.source === 'manifests' ? 'agent_cards_loaded' : 'agent_cards_loaded_fallback', { count: this.agentCards.length });
    }
```
Add the import at the top of `MeshOrchestrator.ts`:
```ts
import { loadChairManifests } from './services/runtime/ChairManifestLoader.js';
```

- [ ] **Step 6: Run the whole suite + build**

Run: `npm run build && npm test`
Expected: `tsc` exit 0; full suite green (≥ 555 + the new tests).

- [ ] **Step 7: Commit**

```bash
git add src/services/runtime/ChairManifestLoader.ts src/__tests__/ChairManifestLoader.test.ts src/MeshOrchestrator.ts
git commit -m "feat(runtime): validate agent_cards via ChairManifestLoader"
```

---

## Phase 1 Exit Criteria

- [ ] `AgentRuntimeSpec.runtime` is `string`; the closed union is gone.
- [ ] `defaultAgentRuntimeSpecs`, `runtimePolicyFor`, `runtimeExecutablePathFor` resolve through `AdapterRegistry`; the 3 built-in chairs behave identically (existing suite green).
- [ ] `agent_cards/*.json` is schema-validated at load; invalid files warn and are skipped; absent dir falls back to TS cards.
- [ ] `npm run build && npm test` green on Node 22 Linux; total test count ≥ 555 + 12 new.
- [ ] Net new code is isolated under `src/services/runtime/` (clean boundary for Phase 2's `CommandAdapter`).

## Handoff to Phase 2

Phase 2 adds: the gated `CommandAdapter` (registers a `command` kind on the registry), `agent_cards/*.json` for all 9 chairs, and the `validate-all-chairs.mjs` manifest lint. It depends only on the `RuntimeAdapter` interface frozen here.
