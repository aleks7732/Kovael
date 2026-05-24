import * as http from 'node:http';

export const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, traceparent, tracestate',
} as const;

export type JsonBody = Record<string, unknown>;
export type JsonWriter = (
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers?: http.OutgoingHttpHeaders,
) => void;
export type JsonBodyReader = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    maxBytes?: number,
    timeoutMs?: number,
) => Promise<JsonBody | null>;

export interface RouteDeps {
    readJsonBody: JsonBodyReader;
    writeJson: JsonWriter;
}

/** Shared JSON response writer with standard CORS + cache headers. */
export function writeJson(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers: http.OutgoingHttpHeaders = {},
): void {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...CORS_HEADERS,
        ...headers,
    });
    res.end(JSON.stringify(body));
}

export function writeNoContent(res: http.ServerResponse): void {
    res.writeHead(204, {
        ...CORS_HEADERS,
        'Access-Control-Max-Age': '86400',
        'Content-Length': '0',
    });
    res.end();
}

export function createRequestUrl(req: http.IncomingMessage): URL {
    return new URL(req.url || '/', `http://${req.headers.host}`);
}

/**
 * Accumulate a JSON POST body with size + time limits.
 * Returns null if the response was already sent on an error path.
 */
export function readJsonBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    maxBytes: number = 16 * 1024,
    timeoutMs: number = 15_000,
): Promise<JsonBody | null> {
    return new Promise((resolve) => {
        let received = 0;
        const chunks: Buffer[] = [];
        let done = false;

        const finish = () => { done = true; clearTimeout(timer); };

        const timer = setTimeout(() => {
            if (done) return;
            finish();
            writeJson(res, 408, { error: 'body_read_timeout' });
            req.destroy(new Error('body_read_timeout'));
            resolve(null);
        }, timeoutMs);
        timer.unref();

        req.on('data', (chunk: Buffer) => {
            if (done) return;
            received += chunk.length;
            if (received > maxBytes) {
                finish();
                writeJson(res, 413, { error: 'payload_too_large', max_bytes: maxBytes });
                req.destroy(new Error('payload_too_large'));
                resolve(null);
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            if (done) return;
            finish();
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw.length === 0) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw) as JsonBody);
            } catch {
                writeJson(res, 400, { error: 'invalid_json' });
                resolve(null);
            }
        });

        req.on('error', () => {
            if (done) return;
            finish();
            writeJson(res, 400, { error: 'request_stream_error' });
            resolve(null);
        });
    });
}
