import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { EpisodicMemory } from '../services/EpisodicMemory.js';
import { openOrchestratorDb } from '../services/OrchestratorDb.js';

describe('EpisodicMemory', () => {
    let db: DatabaseSync;
    let memory: EpisodicMemory;

    beforeEach(() => {
        db = openOrchestratorDb({ path: ':memory:' }).db;
        memory = new EpisodicMemory(db);
    });

    afterEach(() => {
        db.close();
    });

    it('memorizes and recalls by text search', () => {
        memory.memorize({
            cycleId: 'c1',
            agentId: 'nyx',
            taskClass: 'debugging',
            summary: 'The database migration failed due to a schema mismatch',
            outcome: 'failure',
            confidence: 0.8,
        });

        const results = memory.recall('database migration');
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0].entry.summary).toContain('database migration');
    });

    it('returns empty results for no match', () => {
        memory.memorize({
            cycleId: 'c1',
            agentId: 'nyx',
            taskClass: 'general',
            summary: 'The sky is blue',
            outcome: 'success',
            confidence: 0.9,
        });

        const results = memory.recall('quantum computing');
        expect(results).toHaveLength(0);
    });

    it('recalls scoped by agent', () => {
        memory.memorize({
            cycleId: 'c1',
            agentId: 'nyx',
            taskClass: 'build',
            summary: 'Nyx completed the build successfully',
            outcome: 'success',
            confidence: 0.95,
        });
        memory.memorize({
            cycleId: 'c1',
            agentId: 'shaev',
            taskClass: 'design',
            summary: 'Shaev designed the architecture',
            outcome: 'success',
            confidence: 0.9,
        });

        const nyxMemories = memory.recallForAgent('nyx', 'build');
        expect(nyxMemories).toHaveLength(1);
        expect(nyxMemories[0].entry.agentId).toBe('nyx');
    });

    it('retrieves recent memories for an agent', () => {
        for (let i = 0; i < 5; i++) {
            memory.memorize({
                cycleId: `c${i}`,
                agentId: 'nyx',
                taskClass: 'testing',
                summary: `Memory entry ${i}`,
                outcome: 'success',
                confidence: 0.8,
            });
        }

        const recent = memory.recentForAgent('nyx', 3);
        expect(recent).toHaveLength(3);
    });

    it('respects limit in recall', () => {
        for (let i = 0; i < 10; i++) {
            memory.memorize({
                cycleId: `c${i}`,
                agentId: 'nyx',
                taskClass: 'coding',
                summary: `Test content about coding patterns ${i}`,
                outcome: 'success',
                confidence: 0.8,
            });
        }

        const results = memory.recall('coding patterns', 3);
        expect(results).toHaveLength(3);
    });

    it('totalMemories returns correct count', () => {
        expect(memory.totalMemories()).toBe(0);

        memory.memorize({
            cycleId: 'c1',
            agentId: 'nyx',
            taskClass: 'test',
            summary: 'First memory',
            outcome: 'success',
            confidence: 0.9,
        });
        memory.memorize({
            cycleId: 'c2',
            agentId: 'shaev',
            taskClass: 'test',
            summary: 'Second memory',
            outcome: 'failure',
            confidence: 0.3,
        });

        expect(memory.totalMemories()).toBe(2);
    });
});
