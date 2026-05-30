import { z } from 'zod';

export const ChairRuntimeSchema = z.object({
  kind: z.string().min(1),
  supervised: z.boolean().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  allowEnv: z.array(z.string()).optional(),
  elevated: z.boolean().optional(),
});

export const ChairManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  description: z.string().optional(),
  trustTier: z.number().int(),
  capabilities: z.array(z.string()).default([]),
  vram: z.string().default('unknown'),
  beaconHint: z.string().optional(),
  portrait: z.string().optional(),
  accentHex: z.string().optional(),
  runtime: ChairRuntimeSchema.optional(),
});

export type ChairRuntime = z.infer<typeof ChairRuntimeSchema>;
export type ChairManifest = z.infer<typeof ChairManifestSchema>;

export type ParseResult =
  | { ok: true; manifest: ChairManifest }
  | { ok: false; error: string };

export function parseManifest(input: unknown): ParseResult {
  const result = ChairManifestSchema.safeParse(input);
  if (result.success) return { ok: true, manifest: result.data };
  return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}
