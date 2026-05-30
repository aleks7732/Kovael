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
