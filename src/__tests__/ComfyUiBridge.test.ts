import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
});
