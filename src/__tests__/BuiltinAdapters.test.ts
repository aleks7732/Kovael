import { describe, it, expect } from 'vitest';
import { defaultRuntimeRegistry } from '../services/runtime/builtinAdapters.js';
import { AgentCards } from '../AgentCards.js';

describe('builtin adapters', () => {
  it('registers the three typed built-ins plus the generic command adapter', () => {
    expect(defaultRuntimeRegistry().kinds().sort())
      .toEqual(['claude-shaev', 'codex', 'codex-openclaw', 'command']);
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
