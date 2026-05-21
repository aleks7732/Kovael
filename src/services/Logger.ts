type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

export interface LogContext {
    cycle_id?: string;
    task_hash?: string;
    phase?: string;
    routed_agent?: string;
    [key: string]: unknown;
}

export interface LogRecord {
    ts: string;
    level: LogLevel;
    service: string;
    msg: string;
    [key: string]: unknown;
}

export interface LoggerOptions {
    /** Service name baked into every record (e.g., "kovael-mesh"). */
    service: string;
    /** Minimum level to emit. Anything below is dropped. */
    minLevel?: LogLevel;
    /** Destination stream — defaults to process.stdout for log shipping. */
    sink?: (line: string) => void;
    /** Fixed context merged into every record (build, version, host, etc.). */
    baseContext?: LogContext;
}

/**
 * Logger — Symphony §13 structured logging.
 *
 * One JSON object per line on stdout (NDJSON), with the four context fields
 * the spec calls out — cycle_id, task_hash, phase, routed_agent — pinned in
 * the type so they shape every log entry that touches a Triad cycle.
 *
 * Sub-loggers via `scope(ctx)` pin extra fields without mutating the parent;
 * the orchestrator creates a scoped logger per cycle so every line for that
 * cycle carries its cycle_id automatically without manual plumbing.
 *
 * Designed to be cheap: a single string concat + sink call per record, no
 * dependency, no async, no batching. Sinks decide their own buffering.
 */
export class Logger {
    private readonly service: string;
    private readonly minPriority: number;
    private readonly sink: (line: string) => void;
    private readonly baseContext: LogContext;

    constructor(opts: LoggerOptions) {
        this.service = opts.service;
        this.minPriority = LEVEL_PRIORITY[opts.minLevel ?? 'info'];
        this.sink = opts.sink ?? ((line) => process.stdout.write(line + '\n'));
        this.baseContext = opts.baseContext ?? {};
    }

    public scope(extra: LogContext): Logger {
        return new Logger({
            service: this.service,
            minLevel: (Object.keys(LEVEL_PRIORITY) as LogLevel[]).find(l => LEVEL_PRIORITY[l] === this.minPriority),
            sink: this.sink,
            baseContext: { ...this.baseContext, ...extra },
        });
    }

    public debug(msg: string, ctx?: LogContext): void { this.write('debug', msg, ctx); }
    public info(msg: string, ctx?: LogContext): void  { this.write('info',  msg, ctx); }
    public warn(msg: string, ctx?: LogContext): void  { this.write('warn',  msg, ctx); }
    public error(msg: string, ctx?: LogContext): void { this.write('error', msg, ctx); }

    private write(level: LogLevel, msg: string, ctx?: LogContext): void {
        if (LEVEL_PRIORITY[level] < this.minPriority) return;
        const record: LogRecord = {
            ts: new Date().toISOString(),
            level,
            service: this.service,
            msg,
            ...this.baseContext,
            ...(ctx ?? {}),
        };
        try {
            this.sink(JSON.stringify(record));
        } catch {
            // Sink failure must never crash the orchestrator. Drop the line.
        }
    }
}

import { NdjsonFileSink, teeSink } from './FileSink.js';

/**
 * Build the default sink. If `KOVAEL_LOG_FILE` is set, tee to both
 * stdout AND that file (so a sidecar collector — Vector, Alloy, Fluent
 * Bit — can tail it inside a Pod without losing console visibility).
 * Default (env unset) is stdout-only.
 */
function buildDefaultSink(): (line: string) => void {
    const stdoutSink = (line: string) => process.stdout.write(line + '\n');
    const filePath = process.env.KOVAEL_LOG_FILE;
    if (!filePath) return stdoutSink;
    try {
        const fileSink = new NdjsonFileSink({ path: filePath });
        return teeSink(stdoutSink, (line) => fileSink.write(line));
    } catch (err) {
        // File sink couldn't initialize (directory permissions, etc.) —
        // fall back to stdout-only and emit one warning line so the
        // misconfiguration is visible.
        process.stderr.write(
            `kovael-logger: failed to open KOVAEL_LOG_FILE=${filePath}: ${(err as Error).message}\n`,
        );
        return stdoutSink;
    }
}

/**
 * The shared application logger. Components that don't need a scoped logger
 * (boot code, top-level utilities) can import this directly. Components
 * operating on a cycle should scope it with cycle_id at the entry point.
 */
export const rootLogger = new Logger({
    service: 'kovael-mesh',
    minLevel: (process.env.KOVAEL_LOG_LEVEL as LogLevel) ?? 'info',
    sink: buildDefaultSink(),
});
