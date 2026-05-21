import * as fs from 'node:fs';
import * as path from 'node:path';

export interface NdjsonFileSinkOptions {
    path: string;
    /** Rotate when the current file exceeds this size. Default 50 MiB. */
    maxBytes?: number;
    /** Keep at most this many rotated files. Older ones are deleted. Default 5. */
    maxFiles?: number;
    /** Warn once when current file grows past this threshold. Default 80% of maxBytes. */
    warnAtBytes?: number;
    /** Batch flush cadence. 0 flushes synchronously per write. Default 1000ms. */
    flushIntervalMs?: number;
    /** Bounded queue for backpressure; drop-oldest on overflow. Default 1024 lines. */
    maxQueueLines?: number;
    /** Flush immediately when this many lines queue up. Default 256. */
    maxBatchLines?: number;
}

/**
 * Append-only NDJSON sink with size-based rotation.
 *
 * Designed to ride alongside the existing stdout sink so a sidecar log
 * collector (Vector / Alloy / Fluent Bit) can tail one file inside the
 * Pod and ship it onward. The writer is **synchronous** for the same
 * reason the stdout sink is: an uncaught throw mid-write should not
 * drop the line.
 *
 * Rotation policy: when the current file passes `maxBytes`, rename
 * `path → path.1`, shift `.1 → .2`, evict beyond `maxFiles`. New
 * writes hit a fresh empty file.
 */
export class NdjsonFileSink {
    private readonly filePath: string;
    private readonly maxBytes: number;
    private readonly maxFiles: number;
    private readonly warnAtBytes: number;
    private readonly flushIntervalMs: number;
    private readonly maxQueueLines: number;
    private readonly maxBatchLines: number;
    private bytesWritten = 0;
    private warnedAtThreshold = false;
    private queue: string[] = [];
    private droppedLines = 0;
    private flushTimer: NodeJS.Timeout | null = null;

    constructor(opts: NdjsonFileSinkOptions) {
        this.filePath = opts.path;
        this.maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
        this.maxFiles = opts.maxFiles ?? 5;
        this.warnAtBytes = opts.warnAtBytes ?? Math.floor(this.maxBytes * 0.8);
        this.flushIntervalMs = opts.flushIntervalMs ?? 1000;
        this.maxQueueLines = opts.maxQueueLines ?? 1024;
        this.maxBatchLines = opts.maxBatchLines ?? 256;
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        // Seed bytesWritten from current size so rotation tracks an
        // existing file across process restarts.
        try {
            this.bytesWritten = fs.statSync(this.filePath).size;
        } catch {
            this.bytesWritten = 0;
        }
        if (this.flushIntervalMs > 0) {
            this.flushTimer = setInterval(() => this.flushNow(), this.flushIntervalMs);
            this.flushTimer.unref();
        }
    }

    public write(line: string): void {
        // Drop oldest BEFORE push so queue.length never exceeds the bound,
        // even momentarily within a single synchronous write() call.
        if (this.queue.length >= this.maxQueueLines) {
            this.queue.shift();
            this.droppedLines += 1;
        }
        this.queue.push(line);
        if (this.flushIntervalMs === 0 || this.queue.length >= this.maxBatchLines) {
            this.flushNow();
        }
    }

    public flushNow(): void {
        if (this.queue.length === 0) return;
        const lines = this.queue;
        this.queue = [];

        if (this.droppedLines > 0) {
            process.stderr.write(
                `kovael-filesink: dropped ${this.droppedLines} oldest queued lines due to backpressure overflow\n`,
            );
            this.droppedLines = 0;
        }

        const payload = `${lines.join('\n')}\n`;
        const buf = Buffer.from(payload, 'utf8');
        if (this.bytesWritten + buf.byteLength > this.maxBytes) {
            this.rotate();
        }

        const fd = fs.openSync(this.filePath, 'a', 0o600);
        try {
            fs.writeSync(fd, buf);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        this.bytesWritten += buf.byteLength;

        if (!this.warnedAtThreshold && this.bytesWritten >= this.warnAtBytes) {
            this.warnedAtThreshold = true;
            process.stderr.write(
                `kovael-filesink: warning ${this.filePath} reached ${this.bytesWritten} bytes (warn_at=${this.warnAtBytes}, max=${this.maxBytes})\n`,
            );
        }
    }

    public close(): void {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        this.flushNow();
    }

    private rotate(): void {
        // Walk descending so renames don't clobber: maxFiles → maxFiles+1 evicted,
        // then (maxFiles-1) → maxFiles, ..., 1 → 2, base → 1.
        for (let i = this.maxFiles; i >= 1; i -= 1) {
            const older = `${this.filePath}.${i}`;
            if (!fs.existsSync(older)) continue;
            if (i === this.maxFiles) {
                fs.unlinkSync(older);
            } else {
                fs.renameSync(older, `${this.filePath}.${i + 1}`);
            }
        }
        if (fs.existsSync(this.filePath)) {
            fs.renameSync(this.filePath, `${this.filePath}.1`);
        }
        this.bytesWritten = 0;
        this.warnedAtThreshold = false;
    }
}

/**
 * Wraps two sinks so every line goes to both. Failure in one MUST NOT
 * suppress the other — log shipping degrades gracefully when disk
 * fills up or stdout is closed.
 */
export function teeSink(
    a: (line: string) => void,
    b: (line: string) => void,
): (line: string) => void {
    return (line) => {
        try { a(line); } catch { /* drop a-side */ }
        try { b(line); } catch { /* drop b-side */ }
    };
}
