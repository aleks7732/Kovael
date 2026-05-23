import { describe, it, expect, vi } from 'vitest';
import { ComfyUiBridge } from '../services/ComfyUiBridge.js';

describe('ComfyUiBridge Security & Prompt Injection Fuzzer', () => {

    describe('JSON Structural Integrity and Breakout Fuzzing', () => {
        it('prevents JSON structure breakouts across all string inputs', async () => {
            const fetchImpl = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ prompt_id: 'fuzz-queued-123' })
            });
            const bridge = new ComfyUiBridge({ enabled: true, fetchImpl });

            // Payloads designed to break JSON boundaries or inject unexpected keys
            const maliciousInputs = [
                '"} , "kovael_hack": { "class_type": "Exploit" }, "dummy": { "',
                '\\", \\"kovael_portrait\\": { \\"inputs\\": { \\"prompt\\": \\"injected\\" } }',
                '{"kovael_portrait": { "inputs": { "agentId": "admin" } } }',
                '//\n/*\n*/',
                '</script><script>alert(1)</script>',
                '"""""',
                '\\\\\\\\\\\\\\\\'
            ];

            for (const input of maliciousInputs) {
                const result = await bridge.renderPortrait({
                    agentId: input,
                    prompt: input,
                    loras: [
                        { name: input, trigger: input, weight: 1.0 }
                    ]
                });

                expect(result.source).toBe('comfyui');
                expect(fetchImpl).toHaveBeenCalled();

                const lastCall = fetchImpl.mock.lastCall;
                expect(lastCall).toBeDefined();

                const body = JSON.parse(lastCall![1].body);
                const workflow = body.prompt;

                // Verify the structure of the JSON payload remains perfectly intact
                // i.e., no new root-level or unexpected pipelines got injected
                const keys = Object.keys(workflow);
                expect(keys).toEqual(['kovael_portrait']);

                const inputs = workflow.kovael_portrait.inputs;
                expect(inputs.agentId).toBe(input);
                expect(inputs.loras[0].name).toBe(input.replace(/[\r\n\t]/g, ' ').trim());
                expect(inputs.loras[0].trigger).toBe(input.replace(/[\r\n\t]/g, ' ').trim());
            }
        });
    });

    describe('Control Character and Protocol Smuggling Fuzzing', () => {
        it('sanitizes control characters in LoRA metadata to prevent multiline injections', async () => {
            const fetchImpl = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ prompt_id: 'fuzz-queued-123' })
            });
            const bridge = new ComfyUiBridge({ enabled: true, fetchImpl });

            const dirtyInputs = [
                'name\r\ntrigger\tweight',
                'nyx\n\n\n\n\n\n\n\nbrand',
                'alks\t\t\t\t\t\tstrategic',
                '\r\r\r\r\r\r\r\r\r\r\n\n\n\n\n\n\n\n\n\n'
            ];

            for (const dirty of dirtyInputs) {
                await bridge.renderPortrait({
                    agentId: 'shaev',
                    prompt: 'tactical render',
                    loras: [
                        { name: dirty, trigger: dirty }
                    ]
                });

                const [, init] = fetchImpl.mock.lastCall!;
                const workflow = JSON.parse(init.body).prompt;
                const lora = workflow.kovael_portrait.inputs.loras[0];

                // Ensure all control characters are cleaned and collapsed to simple spaces
                expect(lora.name).not.toContain('\n');
                expect(lora.name).not.toContain('\r');
                expect(lora.name).not.toContain('\t');
                expect(lora.trigger).not.toContain('\n');
                expect(lora.trigger).not.toContain('\r');
                expect(lora.trigger).not.toContain('\t');
            }
        });
    });

    describe('LoRA Weight Numeric Fuzzing', () => {
        it('safely handles and clamps all extreme, malformed, or hostile numeric weights', async () => {
            const fetchImpl = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ prompt_id: 'fuzz-queued-123' })
            });
            const bridge = new ComfyUiBridge({ enabled: true, fetchImpl });

            // Array of extreme numeric values
            const extremeWeights = [
                Infinity,
                -Infinity,
                NaN,
                1e30,
                -1e30,
                0.0000000000000000000000001,
                999999999999999999,
                -99999999999999999,
                1.9999999999999,
                -0.5,
                2.5,
                // Test non-numbers casted or coerced by JS runtime inside clamp
                'bad-numeric' as unknown as number,
                {} as unknown as number,
                [] as unknown as number
            ];

            for (const w of extremeWeights) {
                await bridge.renderPortrait({
                    agentId: 'nyx',
                    prompt: 'render test',
                    loras: [
                        { name: 'nyx', weight: w }
                    ]
                });

                const [, init] = fetchImpl.mock.lastCall!;
                const workflow = JSON.parse(init.body).prompt;
                const weight = workflow.kovael_portrait.inputs.loras[0].weight;

                // Weights must ALWAYS be clamped strictly between 0 and 2
                expect(Number.isFinite(weight)).toBe(true);
                expect(weight).toBeLessThanOrEqual(2);
                expect(weight).toBeGreaterThanOrEqual(0);
            }
        });
    });

    describe('XSS and XML/SVG Injection in Fallback Renderer', () => {
        it('escapes hostile payloads inside fallback SVG to prevent stored XSS or XML injection', async () => {
            const bridge = new ComfyUiBridge({ enabled: false });

            const maliciousIds = [
                '"><script>alert(1)</script>',
                '</svg><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject>',
                'nyx-antigravity" onerror="alert(1)',
                "alks-mev' onload='alert(1)",
                'nyx & alks < > " \''
            ];

            for (const id of maliciousIds) {
                const result = await bridge.renderPortrait({
                    agentId: id,
                    prompt: 'portrait test'
                });

                expect(result.source).toBe('fallback');
                expect(result.mimeType).toBe('image/svg+xml');
                expect(result.svg).toBeDefined();

                const svg = result.svg!;
                
                // Assert SVG is clean of raw injection hooks
                expect(svg).not.toContain(id); // must be escaped so exact match is absent
                expect(svg).not.toContain('<script>');
                expect(svg).not.toContain('<iframe>');

                // Verify specific XML entities are correctly rendered
                if (id.includes('<') || id.includes('>')) {
                    expect(svg).toContain('&lt;');
                    expect(svg).toContain('&gt;');
                }
                if (id.includes('&')) {
                    expect(svg).toContain('&amp;');
                }
                if (id.includes('"')) {
                    expect(svg).toContain('&quot;');
                }
                if (id.includes("'")) {
                    expect(svg).toContain('&#39;');
                }
            }
        });
    });

    describe('Palette HSL Normalization Fuzzing', () => {
        it('safely clamps and rounds HSL values under extreme, cyclic, or hostile inputs', async () => {
            const fetchImpl = vi.fn();
            const bridge = new ComfyUiBridge({ enabled: false, fetchImpl });

            const chaoticPalettes = [
                { hue: NaN, saturation: NaN, lightness: NaN },
                { hue: Infinity, saturation: Infinity, lightness: Infinity },
                { hue: -Infinity, saturation: -Infinity, lightness: -Infinity },
                { hue: -360, saturation: -100, lightness: -100 },
                { hue: 720, saturation: 200, lightness: 200 },
                { hue: 1e15, saturation: 1e15, lightness: 1e15 },
                { hue: 24.85, saturation: 62.14, lightness: 48.99 }
            ];

            for (const p of chaoticPalettes) {
                const result = await bridge.renderPortrait({
                    agentId: 'naethara',
                    prompt: 'ethereal code',
                    palette: p
                });

                expect(result.source).toBe('fallback');
                
                // Verify all HSL fields are finite, integers, and properly bounded
                const palette = result.palette;
                expect(Number.isInteger(palette.hue)).toBe(true);
                expect(Number.isInteger(palette.saturation)).toBe(true);
                expect(Number.isInteger(palette.lightness)).toBe(true);

                expect(palette.hue).toBeGreaterThanOrEqual(0);
                expect(palette.hue).toBeLessThanOrEqual(360);

                expect(palette.saturation).toBeGreaterThanOrEqual(0);
                expect(palette.saturation).toBeLessThanOrEqual(100);

                expect(palette.lightness).toBeGreaterThanOrEqual(0);
                expect(palette.lightness).toBeLessThanOrEqual(100);
            }
        });
    });
});
