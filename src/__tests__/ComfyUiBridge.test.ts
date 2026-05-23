import { describe, expect, it, vi } from 'vitest';
import { readFileSync, unlinkSync } from 'node:fs';
import { ComfyUiBridge } from '../services/ComfyUiBridge.js';

describe('ComfyUiBridge', () => {
    it('returns a deterministic HSL fallback without contacting ComfyUI when disabled', async () => {
        const fetchImpl = vi.fn();
        const bridge = new ComfyUiBridge({ enabled: false, fetchImpl });

        const result = await bridge.renderPortrait({
            agentId: 'nyx-codex',
            prompt: 'silver command portrait',
            aspectRatio: '16:9',
            palette: { hue: 24, saturation: 62, lightness: 48 },
        });

        expect(fetchImpl).not.toHaveBeenCalled();
        expect(result.source).toBe('fallback');
        expect(result.width).toBe(1792);
        expect(result.height).toBe(1024);
        expect(result.mimeType).toBe('image/svg+xml');
        expect(result.svg).toContain('hsl(24 62% 48%)');
        expect(result.svg).toContain('nyx-codex');
    });

    it('falls back when the REST bridge is unavailable', async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        const bridge = new ComfyUiBridge({ enabled: true, endpoint: 'http://127.0.0.1:8100', fetchImpl });

        const result = await bridge.renderPortrait({
            agentId: 'shaev',
            prompt: 'visual synthesis specialist',
            aspectRatio: '1:1',
        });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(result.source).toBe('fallback');
        expect(result.width).toBe(1024);
        expect(result.height).toBe(1024);
    });

    it('sends LoRA triggers and aspect dimensions through the JSON prompt payload', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ prompt_id: 'queued-123' }),
        });
        const bridge = new ComfyUiBridge({ enabled: true, endpoint: 'http://127.0.0.1:8100', fetchImpl });

        const result = await bridge.renderPortrait({
            agentId: 'nyx-antigravity',
            prompt: 'spatial theater landscape brief',
            aspectRatio: '16:9',
            loras: [
                { name: 'ember-command', trigger: '<lora:ember-command:0.75>', weight: 0.75 },
                { name: 'silver-flow', weight: 0.35 },
            ],
        });

        expect(result.source).toBe('comfyui');
        expect(result.promptId).toBe('queued-123');
        const [, init] = fetchImpl.mock.calls[0];
        expect(init.method).toBe('POST');
        expect(init.body).toContain('<lora:ember-command:0.75>');
        expect(init.body).toContain('silver-flow');
        expect(init.body).toContain('"width":1792');
        expect(init.body).toContain('"height":1024');
    });

    it('does not use shell-interpreted child_process APIs', () => {
        const source = readFileSync(new URL('../services/ComfyUiBridge.ts', import.meta.url), 'utf8');
        expect(source).not.toMatch(/\bexecSync\b|\bexec\s*\(/);
        expect(source).not.toContain('python -c');
    });

    it('supports new preset aspect ratios: portrait, landscape, theater-card, flowchart', async () => {
        const fetchImpl = vi.fn();
        const bridge = new ComfyUiBridge({ enabled: false, fetchImpl });

        const portraitRes = await bridge.renderPortrait({
            agentId: 'nyx',
            prompt: 'portrait test',
            aspectRatio: 'portrait',
        });
        expect(portraitRes.width).toBe(1024);
        expect(portraitRes.height).toBe(1365);

        const landscapeRes = await bridge.renderPortrait({
            agentId: 'nyx',
            prompt: 'landscape test',
            aspectRatio: 'landscape',
        });
        expect(landscapeRes.width).toBe(1792);
        expect(landscapeRes.height).toBe(1024);

        const theaterRes = await bridge.renderPortrait({
            agentId: 'nyx',
            prompt: 'theater test',
            aspectRatio: 'theater-card',
        });
        expect(theaterRes.width).toBe(1280);
        expect(theaterRes.height).toBe(720);

        const flowchartRes = await bridge.renderPortrait({
            agentId: 'nyx',
            prompt: 'flowchart test',
            aspectRatio: 'flowchart',
        });
        expect(flowchartRes.width).toBe(1920);
        expect(flowchartRes.height).toBe(1080);
    });

    it('enriches LoRAs from the default recipe library (nyx, alks, veyra, naethara)', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ prompt_id: 'queued-123' }),
        });
        const bridge = new ComfyUiBridge({ enabled: true, fetchImpl });

        await bridge.renderPortrait({
            agentId: 'nyx-antigravity',
            prompt: 'master test',
            loras: [
                { name: 'nyx' }, // should get default trigger and weight
                { name: 'veyra', weight: 0.5 }, // should get default trigger but custom weight
            ],
        });

        const [, init] = fetchImpl.mock.calls[0];
        const promptObj = JSON.parse(init.body).prompt;
        const injectedLoras = promptObj.kovael_portrait.inputs.loras;

        // Assert recipe library defaults matched and loaded
        expect(injectedLoras[0].name).toBe('nyx');
        expect(injectedLoras[0].trigger).toBe('nyx_holyfield, athletic platinum blonde, tactical gear');
        expect(injectedLoras[0].weight).toBe(1.0);

        expect(injectedLoras[1].name).toBe('veyra');
        expect(injectedLoras[1].trigger).toBe('veyra_style, high-contrast dark fantasy cinematic epic');
        expect(injectedLoras[1].weight).toBe(0.5);
    });

    it('logs palettes, timestamps, and traceId to a local log file and structured logger', async () => {
        const testLogFile = 'comfyui_metadata_test.log';
        process.env.KOVAEL_COMFYUI_LOG_FILE = testLogFile;

        const fetchImpl = vi.fn();
        const bridge = new ComfyUiBridge({ enabled: false, fetchImpl });

        await bridge.renderPortrait({
            agentId: 'nyx-test',
            prompt: 'test metadata logging',
            traceId: 'test-trace-12345',
            palette: { hue: 120, saturation: 80, lightness: 50 },
        });

        // Verify the file was written
        const logContent = readFileSync(testLogFile, 'utf8');
        expect(logContent).toContain('nyx-test');
        expect(logContent).toContain('test-trace-12345');
        expect(logContent).toContain('"hue":120');

        const parsed = JSON.parse(logContent.trim());
        expect(parsed.traceId).toBe('test-trace-12345');
        expect(parsed.palette.hue).toBe(120);
        expect(parsed.palette.saturation).toBe(80);
        expect(parsed.palette.lightness).toBe(50);
        expect(parsed.timestamp).toBeDefined();

        // Clean up the test log file
        try {
            unlinkSync(testLogFile);
        } catch {
            // ignore cleanup errors
        }
    });
});
