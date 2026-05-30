import { describe, it, expect } from 'vitest';
import { decodeWorkflowConfig } from '../services/WorkflowConfig.js';
import type { WorkflowFrontMatter } from '../services/WorkflowLoader.js';

describe('decodeWorkflowConfig', () => {
  it('decodes routing / sharding / retry with the right type coercion', () => {
    const out = decodeWorkflowConfig({
      routing: { vram_floor_mb: 8192, primary_architect: 'shaev', fallback_agent: 'nyx-cli' },
      sharding: { keep_recent_turns: 12 },
      retry: { max_attempts: 5, backoff_base_ms: 100, backoff_factor: 2 },
    } as unknown as WorkflowFrontMatter);

    expect(out.vramFloor).toBe(8192);
    expect(out.primaryArchitect).toBe('shaev');
    expect(out.fallbackAgent).toBe('nyx-cli');
    expect(out.keepRecentTurns).toBe(12);
    expect(out.retry).toEqual({ maxAttempts: 5, baseMs: 100, factor: 2 });
  });

  it('ignores wrong-typed and missing fields', () => {
    const out = decodeWorkflowConfig({ routing: { vram_floor_mb: 'lots' } } as unknown as WorkflowFrontMatter);
    expect(out.vramFloor).toBeUndefined();
    expect(out.primaryArchitect).toBeUndefined();
    expect(out.retry).toEqual({});
  });
});
