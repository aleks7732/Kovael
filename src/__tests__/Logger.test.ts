import { describe, it, expect } from 'vitest';
import { Logger } from '../services/Logger.js';

describe('Logger', () => {
    it('scope(ctx) emits records with merged context', () => {
        const records: any[] = [];
        const base = new Logger({
            service: 'test-svc',
            minLevel: 'debug',
            sink: line => records.push(JSON.parse(line)),
            baseContext: { cycle_id: 'base-cycle' },
        });
        const scoped = base.scope({ task_hash: 'abc123', phase: 'Running' });
        scoped.info('scoped message');

        expect(records).toHaveLength(1);
        expect(records[0].cycle_id).toBe('base-cycle');
        expect(records[0].task_hash).toBe('abc123');
        expect(records[0].phase).toBe('Running');
        expect(records[0].msg).toBe('scoped message');
        expect(records[0].service).toBe('test-svc');
    });

    it('scope does not mutate the parent logger context', () => {
        const records: any[] = [];
        const base = new Logger({
            service: 'test-svc',
            minLevel: 'debug',
            sink: line => records.push(JSON.parse(line)),
        });
        base.scope({ cycle_id: 'child-cycle' });
        base.info('parent message');

        expect(records[0].cycle_id).toBeUndefined();
    });

    it('minLevel=info filters out debug records', () => {
        const records: any[] = [];
        const logger = new Logger({
            service: 'filter-test',
            minLevel: 'info',
            sink: line => records.push(JSON.parse(line)),
        });
        logger.debug('should be dropped');
        logger.info('should appear');

        expect(records).toHaveLength(1);
        expect(records[0].level).toBe('info');
    });

    it('minLevel=warn filters out debug and info', () => {
        const lines: string[] = [];
        const logger = new Logger({
            service: 'warn-test',
            minLevel: 'warn',
            sink: line => lines.push(line),
        });
        logger.debug('nope');
        logger.info('nope');
        logger.warn('yes');
        logger.error('yes');
        expect(lines).toHaveLength(2);
    });

    it('sink failure is swallowed silently (no crash)', () => {
        const logger = new Logger({
            service: 'crash-test',
            minLevel: 'info',
            sink: () => { throw new Error('sink exploded'); },
        });
        // Must not throw
        expect(() => logger.info('this should not crash')).not.toThrow();
    });

    it('every record includes ts, level, service, and msg fields', () => {
        const records: any[] = [];
        const logger = new Logger({
            service: 'field-check',
            minLevel: 'debug',
            sink: line => records.push(JSON.parse(line)),
        });
        logger.warn('hello');
        expect(records[0]).toMatchObject({
            ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            level: 'warn',
            service: 'field-check',
            msg: 'hello',
        });
    });

    it('per-call ctx overrides base context for that record only', () => {
        const records: any[] = [];
        const logger = new Logger({
            service: 'ctx-override',
            minLevel: 'debug',
            sink: line => records.push(JSON.parse(line)),
            baseContext: { phase: 'base-phase' },
        });
        logger.info('first', { phase: 'overridden-phase' });
        logger.info('second');

        expect(records[0].phase).toBe('overridden-phase');
        expect(records[1].phase).toBe('base-phase');
    });
});
