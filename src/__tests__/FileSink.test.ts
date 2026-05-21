import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { NdjsonFileSink, teeSink } from '../services/FileSink.js';

describe('NdjsonFileSink', () => {
    let dir: string;
    let filePath: string;

    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), 'kovael-filesink-'));
        filePath = path.join(dir, 'orchestrator.log');
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('appends one record per line and appends newline terminator', () => {
        const sink = new NdjsonFileSink({ path: filePath, flushIntervalMs: 0 });
        sink.write('{"a":1}');
        sink.write('{"b":2}');
        sink.write('{"c":3}');

        const body = readFileSync(filePath, 'utf8');
        expect(body).toBe('{"a":1}\n{"b":2}\n{"c":3}\n');
        expect(body.split('\n').filter(Boolean)).toHaveLength(3);
    });

    it('creates the parent directory if it does not exist', () => {
        const nested = path.join(dir, 'a', 'b', 'c', 'orchestrator.log');
        const sink = new NdjsonFileSink({ path: nested, flushIntervalMs: 0 });
        sink.write('{"hello":"world"}');
        expect(existsSync(nested)).toBe(true);
    });

    it('rotates the file when maxBytes is exceeded', () => {
        // Each line is 10 bytes ('xxxxxxxxx\n') so any single write past
        // the threshold triggers rotation. maxBytes=20 → after 2 writes
        // the 3rd triggers rotation.
        const sink = new NdjsonFileSink({ path: filePath, maxBytes: 20, flushIntervalMs: 0 });
        sink.write('xxxxxxxxx'); // 10 bytes → bytesWritten=10
        sink.write('yyyyyyyyy'); // 10 bytes → bytesWritten=20
        sink.write('zzzzzzzzz'); // would push to 30 → rotates first

        expect(existsSync(`${filePath}.1`)).toBe(true);
        const rotated = readFileSync(`${filePath}.1`, 'utf8');
        expect(rotated).toBe('xxxxxxxxx\nyyyyyyyyy\n');
        const current = readFileSync(filePath, 'utf8');
        expect(current).toBe('zzzzzzzzz\n');
    });

    it('evicts oldest rotated files past maxFiles', () => {
        const sink = new NdjsonFileSink({ path: filePath, maxBytes: 5, maxFiles: 2, flushIntervalMs: 0 });
        // Each write rotates because 5-byte line + newline = 6 > maxBytes=5.
        sink.write('aaaa'); // → file
        sink.write('bbbb'); // rotates: file→.1, file=bbbb
        sink.write('cccc'); // rotates: .1→.2, file→.1, file=cccc
        sink.write('dddd'); // rotates: .2 evicted, .1→.2, file→.1, file=dddd

        expect(readFileSync(filePath, 'utf8')).toBe('dddd\n');
        expect(readFileSync(`${filePath}.1`, 'utf8')).toBe('cccc\n');
        expect(readFileSync(`${filePath}.2`, 'utf8')).toBe('bbbb\n');
        // .3 must never exist — maxFiles=2 caps the chain at .1 and .2.
        expect(existsSync(`${filePath}.3`)).toBe(false);
    });

    it('creates files with owner-only permissions (0o600)', () => {
        const sink = new NdjsonFileSink({ path: filePath, flushIntervalMs: 0 });
        sink.write('{"a":1}');
        const perms = statSync(filePath).mode & 0o777;
        expect(perms).toBe(0o600);
    });

    it('drops oldest queued lines on overflow and emits a backpressure warning', () => {
        const stderr: string[] = [];
        const orig = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: any) => {
            stderr.push(String(chunk));
            return true;
        }) as any;
        try {
            const sink = new NdjsonFileSink({
                path: filePath,
                flushIntervalMs: 1000,
                maxQueueLines: 2,
                maxBatchLines: 999,
            });
            sink.write('line-1');
            sink.write('line-2');
            sink.write('line-3');
            sink.flushNow();
            sink.close();

            expect(readFileSync(filePath, 'utf8')).toBe('line-2\nline-3\n');
            expect(stderr.join('\n')).toContain('dropped 1 oldest queued lines');
        } finally {
            process.stderr.write = orig as any;
        }
    });
});

describe('teeSink', () => {
    it('writes to both downstreams', () => {
        const a: string[] = [];
        const b: string[] = [];
        const sink = teeSink((l) => a.push(l), (l) => b.push(l));
        sink('hello');
        sink('world');
        expect(a).toEqual(['hello', 'world']);
        expect(b).toEqual(['hello', 'world']);
    });

    it('failure in one downstream does not suppress the other', () => {
        const b: string[] = [];
        const sink = teeSink(
            () => { throw new Error('a-side dead'); },
            (l) => b.push(l),
        );
        sink('still routed');
        expect(b).toEqual(['still routed']);
    });
});
