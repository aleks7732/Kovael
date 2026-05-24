import * as http from 'node:http';
import type { OrchestratorContext } from '../OrchestratorContext.js';
import type { ComfyAspectRatio, LoraMixerUpdate } from '../ComfyUiBridge.js';
import type { RouteDeps } from './HttpApiSupport.js';
import { createRequestUrl } from './HttpApiSupport.js';

export async function handleComfyRequest(
    context: OrchestratorContext,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    deps: RouteDeps,
): Promise<void> {
    if (req.method !== 'POST') {
        deps.writeJson(res, 405, { error: 'method_not_allowed' });
        return;
    }

    const url = createRequestUrl(req);
    const action = url.pathname.replace(/^\/api\/v1\/comfy\/?/, '') || '';

    const body = await deps.readJsonBody(req, res);
    if (body === null) return;

    if (action === 'render' || action === 'mix') {
        const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!agentId || !prompt) {
            deps.writeJson(res, 400, { error: 'missing_required_fields', need: ['agentId', 'prompt'] });
            return;
        }
        try {
            const mixer = Array.isArray(body.mixer) ? sanitizeMixer(body.mixer) : [];
            const result = mixer.length > 0
                ? await context.comfyBridge.renderWithMixer({
                      agentId,
                      prompt,
                      aspectRatio: safeAspectRatio(body.aspectRatio),
                      traceId: typeof body.traceId === 'string' ? body.traceId : undefined,
                      mixer,
                   })
                : await context.comfyBridge.renderPortrait({
                      agentId,
                      prompt,
                      aspectRatio: safeAspectRatio(body.aspectRatio),
                      traceId: typeof body.traceId === 'string' ? body.traceId : undefined,
                   });
            const stream = result.promptId ? context.comfyBridge.streamDescriptor(result.promptId) : undefined;
            deps.writeJson(res, 200, {
                source: result.source,
                agentId: result.agentId,
                width: result.width,
                height: result.height,
                mimeType: result.mimeType,
                promptId: result.promptId,
                svg: result.svg,
                palette: result.palette,
                error: result.error,
                stream,
            });
        } catch (err) {
            deps.writeJson(res, 500, { error: 'comfy_render_failed', message: err instanceof Error ? err.message : String(err) });
        }
        return;
    }

    if (action === 'stream-url') {
        const promptId = typeof body.promptId === 'string' ? body.promptId.trim() : '';
        if (!promptId) {
            deps.writeJson(res, 400, { error: 'missing_required_fields', need: ['promptId'] });
            return;
        }
        deps.writeJson(res, 200, context.comfyBridge.streamDescriptor(promptId, typeof body.clientId === 'string' ? body.clientId : undefined));
        return;
    }

    deps.writeJson(res, 404, { error: 'unknown_comfy_action', action });
}

const ALLOWED_ASPECT_RATIOS = new Set<ComfyAspectRatio>(['1:1', '16:9', '9:16', '4:3', '3:4', 'portrait', 'landscape', 'theater-card', 'flowchart']);

function safeAspectRatio(value: unknown): ComfyAspectRatio | undefined {
    return typeof value === 'string' && ALLOWED_ASPECT_RATIOS.has(value as ComfyAspectRatio) ? value as ComfyAspectRatio : undefined;
}

function sanitizeMixer(input: unknown[]): LoraMixerUpdate[] {
    const out: LoraMixerUpdate[] = [];
    for (const item of input) {
        const raw = item as Record<string, unknown>;
        const recipeId = typeof raw.recipeId === 'string' ? raw.recipeId.replace(/[\r\n\t]/g, ' ').trim() : '';
        if (!recipeId) continue;
        const update: LoraMixerUpdate = {
            recipeId: recipeId.slice(0, 80),
            strength: boundedNumber(raw.strength, 0, 2, 1),
            denoise: boundedNumber(raw.denoise, 0, 1, 0.55),
        };
        if (typeof raw.trigger === 'string') {
            update.trigger = raw.trigger.replace(/[\r\n\t]/g, ' ').trim().slice(0, 240);
        }
        out.push(update);
        if (out.length >= 16) break;
    }
    return out;
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}
