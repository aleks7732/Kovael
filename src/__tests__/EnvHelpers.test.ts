import { describe, it, expect } from 'vitest';
import { readBoolean, readBooleanEnv } from '../common/env-helpers.js';

describe('env-helpers', () => {
  it('readBoolean parses truthy/falsy tokens (trim + case-insensitive)', () => {
    for (const v of ['1', 'true', 'TRUE', ' yes ', 'on']) expect(readBoolean(v, false)).toBe(true);
    for (const v of ['0', 'false', 'no', 'OFF']) expect(readBoolean(v, true)).toBe(false);
  });

  it('readBoolean falls back on unset/unrecognized', () => {
    expect(readBoolean(undefined, true)).toBe(true);
    expect(readBoolean('maybe', false)).toBe(false);
  });

  it('readBooleanEnv reads from a provided env map', () => {
    expect(readBooleanEnv('X', false, { X: 'yes' } as NodeJS.ProcessEnv)).toBe(true);
    expect(readBooleanEnv('MISSING', true, {} as NodeJS.ProcessEnv)).toBe(true);
  });
});
