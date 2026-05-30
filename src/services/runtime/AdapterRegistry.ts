import type { AgentCard } from '../../AgentCards.js';

export interface RuntimeSpecDraft {
  agentId: string;
  provider: string;
  runtime: string;
  capabilities?: string[];
  trustTier?: number;
  cwd?: string;
  model?: string;
  /** Generic-command runtime fields (CommandAdapter only). */
  command?: string;
  args?: string[];
  allowEnv?: string[];
}

export interface RuntimePolicy {
  sandboxMode: 'read-only' | 'danger-full-access' | null;
  permissionMode: 'dontAsk' | null;
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
