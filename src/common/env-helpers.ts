/**
 * Shared boolean env parsing. Recognizes `1/true/yes/on` (→ true) and
 * `0/false/no/off` (→ false), case-insensitive and trimmed; anything else
 * (including unset) yields the caller's fallback.
 */

export function readBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

/** Read a boolean-ish env var by name (defaults to `process.env`). */
export function readBooleanEnv(name: string, fallback: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return readBoolean(env[name], fallback);
}
