import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LearningMatrix } from '../services/LearningMatrix.js';

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('LearningMatrix', () => {
    it('stores bounded sanitized receipt metrics without raw prompt fields', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kovael-learning-'));
        dirs.push(dir);
        const matrix = new LearningMatrix(path.join(dir, '.kovael/learning_matrix.json'), 2);

        matrix.record({
            cycleId: 'cycle-1',
            taskHash: 'hash-1',
            status: 'verified',
            latencyMs: 120,
            tokenTotal: 42,
            confidence: 0.91,
            retryCount: 0,
            recipeIds: ['nyx\nbad'],
            timestamp: 1000,
        });
        matrix.record({
            cycleId: 'cycle-2',
            taskHash: 'hash-2',
            status: 'failed',
            latencyMs: 200,
            tokenTotal: 55,
            confidence: 0.2,
            retryCount: 2,
            recipeIds: ['veyra'],
            timestamp: 2000,
        });
        matrix.record({
            cycleId: 'cycle-3',
            taskHash: 'hash-3',
            status: 'verified',
            latencyMs: 300,
            tokenTotal: 66,
            confidence: 0.7,
            retryCount: 1,
            recipeIds: ['nyx', 'veyra'],
            timestamp: 3000,
        });

        const raw = fs.readFileSync(path.join(dir, '.kovael/learning_matrix.json'), 'utf8');
        expect(raw).not.toContain('prompt');
        const file = matrix.read();
        expect(file.entries).toHaveLength(2);
        expect(file.entries.map((entry) => entry.cycleId)).toEqual(['cycle-3', 'cycle-2']);
        expect(matrix.stats()).toMatchObject({ entries: 2, latestAt: 3000 });
    });

    it('isolates corrupt persisted JSON and keeps callers alive', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kovael-learning-corrupt-'));
        dirs.push(dir);
        const filePath = path.join(dir, '.kovael/learning_matrix.json');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, '{not-json', 'utf8');

        const matrix = new LearningMatrix(filePath, 2);

        expect(matrix.read()).toEqual({ version: 1, entries: [] });
        expect(() => matrix.record({
            cycleId: 'cycle-1',
            taskHash: 'hash-1',
            status: 'verified',
            latencyMs: 1,
            tokenTotal: 1,
            confidence: 1,
            retryCount: 0,
            recipeIds: [],
            timestamp: 1,
        })).not.toThrow();
    });
});
