import type { WorkflowFrontMatter } from './WorkflowLoader.js';
import type { RetryConfig } from './RetryQueue.js';

export interface DecodedWorkflowConfig {
    vramFloor?: number;
    primaryArchitect?: string;
    fallbackAgent?: string;
    keepRecentTurns?: number;
    retry: Partial<RetryConfig>;
}

/**
 * Pure decode of a workflow document's front matter into the typed config the
 * orchestrator applies to MevBridge / RetryQueue. Extracted from
 * MeshOrchestrator.wireWorkflowLoader so the type-coercion logic is unit-testable
 * in isolation (the handler stays a thin "decode then apply").
 */
export function decodeWorkflowConfig(fm: WorkflowFrontMatter): DecodedWorkflowConfig {
    const out: DecodedWorkflowConfig = { retry: {} };
    if (typeof fm.routing?.vram_floor_mb === 'number') out.vramFloor = fm.routing.vram_floor_mb;
    if (typeof fm.routing?.primary_architect === 'string') out.primaryArchitect = fm.routing.primary_architect;
    if (typeof fm.routing?.fallback_agent === 'string') out.fallbackAgent = fm.routing.fallback_agent;
    if (typeof fm.sharding?.keep_recent_turns === 'number') out.keepRecentTurns = fm.sharding.keep_recent_turns;
    if (typeof fm.retry?.max_attempts === 'number') out.retry.maxAttempts = fm.retry.max_attempts;
    if (typeof fm.retry?.backoff_base_ms === 'number') out.retry.baseMs = fm.retry.backoff_base_ms;
    if (typeof fm.retry?.backoff_factor === 'number') out.retry.factor = fm.retry.backoff_factor;
    return out;
}
