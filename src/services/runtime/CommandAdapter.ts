import type { AgentCard } from '../../AgentCards.js';
import type { RuntimeAdapter, RuntimePolicy, RuntimeSpecDraft } from './AdapterRegistry.js';

/**
 * Generic, hard-gated runtime adapter for the long tail of chairs (ADK/Python,
 * Cowork, …). Registers the `command` kind. It is **disabled by default**: a
 * command chair runs only when its binary is listed in
 * `KOVAEL_COMMAND_ADAPTER_ALLOW` (comma-separated). Per-manifest `allowEnv`
 * gates which env vars reach the child; args are an array (no shell). The
 * binary is the trust boundary — this adapter never widens a claimed token into
 * arbitrary host execution beyond the operator's explicit allow-list.
 */

export const COMMAND_ADAPTER_ALLOW_ENV = 'KOVAEL_COMMAND_ADAPTER_ALLOW';

/** Parse the comma-separated binary allow-list. Empty/unset ⇒ adapter disabled. */
export function parseCommandAllowList(env: NodeJS.ProcessEnv): string[] {
  return (env[COMMAND_ADAPTER_ALLOW_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Is `command` permitted to run by the operator's allow-list? */
export function isCommandAllowed(command: string | undefined, env: NodeJS.ProcessEnv): boolean {
  if (!command) return false;
  return parseCommandAllowList(env).includes(command);
}

export const commandAdapter: RuntimeAdapter = {
  kind: 'command',
  supervised: true,
  buildSpec(card: AgentCard): RuntimeSpecDraft {
    const rt = card.runtime;
    return {
      agentId: card.id,
      provider: card.provider,
      runtime: 'command',
      capabilities: card.mcp_capabilities,
      trustTier: card.trust_tier,
      command: rt?.command,
      args: rt?.args ? [...rt.args] : undefined,
      allowEnv: rt?.allowEnv ? [...rt.allowEnv] : undefined,
    };
  },
  policy(): RuntimePolicy {
    // Most-restrictive preflight policy; the allow-listed binary is the trust
    // boundary, not a permission mode here.
    return { sandboxMode: null, permissionMode: 'dontAsk', allowedTools: [], sessionPersistence: false };
  },
  resolveExecutable(_env: NodeJS.ProcessEnv): string {
    // The concrete binary is per-manifest (spec.command); the `command` kind has
    // no single executable. Returned only for the informational preflight summary.
    return 'command';
  },
};
