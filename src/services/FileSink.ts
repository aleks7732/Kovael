import * as fs from 'node:fs';
import * as path from 'node:path';

export interface NdjsonFileSinkOptions {
    path: string;
    /** Rotate when the current file exceeds this size. Default 50 MiB. */
    maxBytes?: number;
    /** Keep at most this many rotated files. Older ones are deleted. Default 5. */
    maxFiles?: number;
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
    private bytesWritten = 0;

    constructor(opts: NdjsonFileSinkOptions) {
        this.filePath = opts.path;
        this.maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
        this.maxFiles = opts.maxFiles ?? 5;
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        // Seed bytesWritten from current size so rotation tracks an
        // existing file across process restarts.
        try {
            this.bytesWritten = fs.statSync(this.filePath).size;
        } catch {
            this.bytesWritten = 0;
        }
    }

    public write(line: string): void {
        const buf = Buffer.from(line + '\n', 'utf8');
        if (this.bytesWritten + buf.byteLength > this.maxBytes) {
            this.rotate();
        }
        fs.appendFileSync(this.filePath, buf);
        this.bytesWritten += buf.byteLength;
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
