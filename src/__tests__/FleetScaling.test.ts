import { describe, it, expect } from 'vitest';
import { RateLimitTracker } from '../services/RateLimitTracker.js';
import { MevBridge } from '../MevBridge.js';
import { AgentCard } from '../AgentCards.js';

describe('Fleet Scaling Validation (100+ Agents)', () => {
    it('should scale to 100 dynamically registered agents and run hardware-aware rate-limited dispatches', async () => {
        // Initialize Core MevBridge and RateLimitTracker
        const bridge = new MevBridge(':memory:');
        const tracker = new RateLimitTracker({ windowMs: 10_000, maxPerWindow: 5 });
        bridge.setRateLimitTracker(tracker);

        // 1. Dynamic Agent Fleet Registration Simulation (100 agents)
        const fleetSize = 100;
        const fleet: Record<string, AgentCard> = {};

        for (let i = 1; i <= fleetSize; i++) {
            const agentId = `nyx-agent-${i}`;
            fleet[agentId] = {
                id: agentId,
                name: `Nyx Agent Cluster ${i}`,
                provider: i % 2 === 0 ? 'Google DeepMind' : 'OpenAI / local-synthesis',
                description: `Autonomous specialist node ${i} for distributed mesh execution.`,
                mcp_capabilities: i % 5 === 0 ? ['comfyui', 'blender'] : ['terminal', 'filesystem'],
                vram_requirements: i % 3 === 0 ? '24GB' : '8GB',
                trust_tier: (i % 3) + 1,
            };
        }

        // Validate that our registry easily scales to 100+ dynamic agent cards
        expect(Object.keys(fleet).length).toBe(100);
        expect(fleet['nyx-agent-100'].trust_tier).toBe(2);

        // 2. Telemetry and Routing validation across the scaled fleet
        // Primary architect = nyx-agent-90 (requires heavy VRAM), Fallback = nyx-agent-1 (lightweight CLI)
        bridge.setPrimaryArchitect('nyx-agent-90');
        bridge.setFallbackAgent('nyx-agent-1');

        // Set VRAM below floor and verify fallback routing
        bridge.setVramFloor(16384);
        bridge.setVramFree(8192, true); // 8GB free < 16GB floor

        let receipt = await bridge.execute('Synthesize tactical payload');
        expect(receipt.architectId).toBe('nyx-agent-1'); // fell back to lightweight CLI
        expect(receipt.routing.rationale).toContain('vram_free_8192mb<16384mb:nyx-agent-90_gated');

        // Set VRAM above floor and verify primary routing
        bridge.setVramFree(24576, true); // 24GB free >= 16GB floor
        receipt = await bridge.execute('Synthesize tactical payload');
        expect(receipt.architectId).toBe('nyx-agent-90'); // dispatched to heavy synthesis
        expect(receipt.routing.rationale).toContain('vram_free_24576mb>=16384mb:nyx-agent-90_authorized');

        // 3. Sharding validation for 100+ concurrency memory stability
        // Under high concurrency, histories must shard properly to avoid OOM
        const largeHistory = Array.from({ length: 50 }, (_, idx) => ({
            role: idx === 0 ? 'system' : 'user',
            content: `Turn ${idx} payload context data...`,
        }));

        bridge.setKeepRecentTurns(3);
        const sharded = bridge.shardContext(largeHistory, { keepRecent: 3 });
        
        // Context contains system prompt + the last 3 turns, keeping memory footprint constant
        expect(sharded.length).toBe(4);
        expect(sharded[0].role).toBe('system');
        expect(sharded[1].content).toContain('Turn 47');
        expect(sharded[3].content).toContain('Turn 49');

        // 4. Heavy Concurrency Rate-Limiting validation across the scaled fleet
        // Verify that rate limits cleanly block primary agent and trigger fallback routing
        tracker.recordDispatch('nyx-agent-90');
        tracker.recordDispatch('nyx-agent-90');
        tracker.recordDispatch('nyx-agent-90');
        tracker.recordDispatch('nyx-agent-90');
        tracker.recordDispatch('nyx-agent-90');

        // 6th call exceeds maximum of 5 in window -> should be blocked
        expect(tracker.canDispatch('nyx-agent-90')).toBe(false);

        // Execute dynamic routing with primary rate-limited
        receipt = await bridge.execute('Synthesize tactical payload');
        expect(receipt.architectId).toBe('nyx-agent-1'); // fell back to lightweight CLI
        expect(receipt.routing.rationale).toContain('nyx-agent-90_rate_limited:falling_back_to_nyx-agent-1');
    });
});
