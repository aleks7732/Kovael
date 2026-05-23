import { appendFileSync } from 'node:fs';
import { rootLogger } from './Logger.js';

export type ComfyAspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | 'portrait' | 'landscape' | 'theater-card' | 'flowchart';

export interface HslPalette {
    hue: number;
    saturation: number;
    lightness: number;
}

export interface LoraInjection {
    name: string;
    trigger?: string;
    weight?: number;
}

export interface RenderPortraitRequest {
    agentId: string;
    prompt: string;
    aspectRatio?: ComfyAspectRatio;
    palette?: Partial<HslPalette>;
    loras?: LoraInjection[];
    traceId?: string;
}

export interface RenderPortraitResult {
    source: 'comfyui' | 'fallback';
    agentId: string;
    width: number;
    height: number;
    mimeType: 'image/png' | 'image/svg+xml';
    promptId?: string;
    svg?: string;
    palette: HslPalette;
    workflow: Record<string, unknown>;
    error?: string;
}

interface FetchResponseLike {
    ok: boolean;
    status?: number;
    json(): Promise<unknown>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponseLike>;

export interface ComfyUiBridgeOptions {
    enabled?: boolean;
    endpoint?: string;
    fetchImpl?: FetchLike;
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8100';

const ASPECT_DIMENSIONS: Record<ComfyAspectRatio, { width: number; height: number }> = {
    '1:1': { width: 1024, height: 1024 },
    '16:9': { width: 1792, height: 1024 },
    '9:16': { width: 1024, height: 1792 },
    '4:3': { width: 1365, height: 1024 },
    '3:4': { width: 1024, height: 1365 },
    'portrait': { width: 1024, height: 1365 },
    'landscape': { width: 1792, height: 1024 },
    'theater-card': { width: 1280, height: 720 },
    'flowchart': { width: 1920, height: 1080 },
};

// LoRA default recipe library for Kovael & Antigravity agents
export const LORA_RECIPE_LIBRARY: Record<string, { trigger: string; weight: number }> = {
    'nyx': { trigger: 'nyx_holyfield, athletic platinum blonde, tactical gear', weight: 1.0 },
    'alks': { trigger: 'alks_mev_nyx, ice-blue eyes, strategic console', weight: 1.0 },
    'veyra': { trigger: 'veyra_style, high-contrast dark fantasy cinematic epic', weight: 0.85 },
    'naethara': { trigger: 'naethara_voice, ethereal cybernetic priestess', weight: 0.9 },
};

export class ComfyUiBridge {
    private readonly enabled: boolean;
    private readonly endpoint: string;
    private readonly fetchImpl: FetchLike;

    constructor(options: ComfyUiBridgeOptions = {}) {
        this.enabled = options.enabled ?? process.env.KOVAEL_COMFYUI_BRIDGE === 'true';
        this.endpoint = normalizeEndpoint(options.endpoint ?? process.env.KOVAEL_COMFYUI_ENDPOINT ?? DEFAULT_ENDPOINT);
        this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    }

    public async renderPortrait(request: RenderPortraitRequest): Promise<RenderPortraitResult> {
        const aspectRatio = request.aspectRatio ?? '1:1';
        const dimensions = ASPECT_DIMENSIONS[aspectRatio];
        const palette = normalizePalette(request.palette);
        const workflow = buildWorkflow(request, dimensions, palette);

        let result: RenderPortraitResult;

        if (!this.enabled) {
            result = this.fallback(request, dimensions, palette, workflow);
        } else {
            try {
                const response = await this.fetchImpl(`${this.endpoint}/prompt`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ prompt: workflow }),
                });
                if (!response.ok) {
                    result = this.fallback(request, dimensions, palette, workflow, `http_${response.status ?? 'error'}`);
                } else {
                    const body = await response.json();
                    const promptId = readPromptId(body);
                    result = {
                        source: 'comfyui',
                        agentId: request.agentId,
                        width: dimensions.width,
                        height: dimensions.height,
                        mimeType: 'image/png',
                        promptId,
                        palette,
                        workflow,
                    };
                }
            } catch (err) {
                result = this.fallback(
                    request,
                    dimensions,
                    palette,
                    workflow,
                    err instanceof Error ? err.message : String(err),
                );
            }
        }

        // Local metadata logging
        this.logMetadata(request, result, palette);

        return result;
    }

    private logMetadata(request: RenderPortraitRequest, result: RenderPortraitResult, palette: HslPalette): void {
        const logEntry = {
            timestamp: new Date().toISOString(),
            agentId: request.agentId,
            prompt: request.prompt,
            aspectRatio: request.aspectRatio ?? '1:1',
            width: result.width,
            height: result.height,
            palette,
            loras: request.loras ?? [],
            source: result.source,
            traceId: request.traceId || 'n/a',
            error: result.error,
        };

        // Emit to structured rootLogger
        rootLogger.info('comfyui_portrait_rendered', logEntry);

        // Append locally to file
        try {
            const logFile = process.env.KOVAEL_COMFYUI_LOG_FILE || 'comfyui_metadata.log';
            appendFileSync(logFile, JSON.stringify(logEntry) + '\n', 'utf8');
        } catch {
            // Swallow logging file errors to ensure absolute resilience
        }
    }

    private fallback(
        request: RenderPortraitRequest,
        dimensions: { width: number; height: number },
        palette: HslPalette,
        workflow: Record<string, unknown>,
        error?: string,
    ): RenderPortraitResult {
        return {
            source: 'fallback',
            agentId: request.agentId,
            width: dimensions.width,
            height: dimensions.height,
            mimeType: 'image/svg+xml',
            svg: renderFallbackSvg(request.agentId, dimensions, palette),
            palette,
            workflow,
            error,
        };
    }
}

function buildWorkflow(
    request: RenderPortraitRequest,
    dimensions: { width: number; height: number },
    palette: HslPalette,
): Record<string, unknown> {
    const loras = (request.loras ?? []).map((lora) => {
        const nameLower = lora.name.toLowerCase();
        const recipe = LORA_RECIPE_LIBRARY[nameLower];
        const trigger = lora.trigger ?? recipe?.trigger ?? lora.name;
        const weight = lora.weight !== undefined ? lora.weight : (recipe?.weight ?? 1.0);

        return {
            name: cleanToken(lora.name),
            trigger: cleanToken(trigger),
            weight: clampNumber(weight, 0, 2),
        };
    });
    const loraPrompt = loras.map((lora) => `${lora.trigger}:${lora.weight}`).join(' ');
    const positivePrompt = [request.prompt.trim(), loraPrompt, `hsl(${palette.hue} ${palette.saturation}% ${palette.lightness}%)`]
        .filter((part) => part.length > 0)
        .join(' ');

    return {
        kovael_portrait: {
            class_type: 'KovaelPortraitPipeline',
            inputs: {
                agentId: request.agentId,
                prompt: positivePrompt,
                width: dimensions.width,
                height: dimensions.height,
                palette,
                loras,
            },
        },
    };
}

function renderFallbackSvg(
    agentId: string,
    dimensions: { width: number; height: number },
    palette: HslPalette,
): string {
    const label = escapeXml(agentId);
    const accent = `hsl(${palette.hue} ${palette.saturation}% ${palette.lightness}%)`;
    const dark = `hsl(${palette.hue} ${Math.max(20, palette.saturation - 18)}% ${Math.max(10, palette.lightness - 28)}%)`;
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.width}" height="${dimensions.height}" viewBox="0 0 ${dimensions.width} ${dimensions.height}" role="img" aria-label="${label} fallback portrait">`,
        `<rect width="100%" height="100%" fill="${dark}"/>`,
        `<circle cx="${dimensions.width / 2}" cy="${dimensions.height / 2}" r="${Math.min(dimensions.width, dimensions.height) * 0.28}" fill="${accent}" opacity="0.88"/>`,
        `<circle cx="${dimensions.width / 2}" cy="${dimensions.height / 2}" r="${Math.min(dimensions.width, dimensions.height) * 0.18}" fill="none" stroke="hsl(${palette.hue} 90% 92%)" stroke-width="12" opacity="0.55"/>`,
        `<text x="50%" y="52%" text-anchor="middle" fill="hsl(${palette.hue} 90% 94%)" font-family="Arial, sans-serif" font-size="${Math.max(28, Math.floor(dimensions.width / 24))}" font-weight="700">${label}</text>`,
        '</svg>',
    ].join('');
}

function normalizePalette(input: Partial<HslPalette> | undefined): HslPalette {
    return {
        hue: Math.round(clampNumber(input?.hue ?? 24, 0, 360)),
        saturation: Math.round(clampNumber(input?.saturation ?? 62, 0, 100)),
        lightness: Math.round(clampNumber(input?.lightness ?? 48, 0, 100)),
    };
}

function clampNumber(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
}

function normalizeEndpoint(endpoint: string): string {
    return endpoint.replace(/\/+$/, '');
}

function readPromptId(body: unknown): string | undefined {
    if (body && typeof body === 'object' && 'prompt_id' in body) {
        const value = (body as { prompt_id?: unknown }).prompt_id;
        if (typeof value === 'string') return value;
    }
    return undefined;
}

function cleanToken(value: string): string {
    return value.replace(/[\r\n\t]/g, ' ').trim();
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
