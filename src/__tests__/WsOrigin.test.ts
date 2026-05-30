import { describe, it, expect } from 'vitest';
import { isAllowedWsOrigin } from '../services/WebSocketBus.js';

describe('isAllowedWsOrigin (anti-CSWSH / DNS-rebind)', () => {
  it('allows header-less (non-browser) clients', () => {
    expect(isAllowedWsOrigin(undefined, [])).toBe(true);
    expect(isAllowedWsOrigin('', [])).toBe(true);
  });

  it('allows loopback origins on any port', () => {
    for (const o of ['http://localhost:5173', 'http://127.0.0.1:8080', 'https://localhost', 'http://[::1]:9000']) {
      expect(isAllowedWsOrigin(o, []), o).toBe(true);
    }
  });

  it('rejects remote browser origins even with the bearer gate off', () => {
    expect(isAllowedWsOrigin('http://evil.com', [])).toBe(false);
    expect(isAllowedWsOrigin('https://attacker.example:443', [])).toBe(false);
    // DNS-rebind: page origin stays evil.com even when it resolves to 127.0.0.1
    expect(isAllowedWsOrigin('http://rebind.evil', [])).toBe(false);
  });

  it('rejects loopback-lookalike and userinfo tricks', () => {
    expect(isAllowedWsOrigin('http://localhost.evil.com', [])).toBe(false);
    expect(isAllowedWsOrigin('http://127.0.0.1.evil.com', [])).toBe(false);
    expect(isAllowedWsOrigin('http://127.0.0.1@evil.com', [])).toBe(false); // userinfo, host is evil.com
  });

  it('honors an explicit allow-list (for non-loopback binds)', () => {
    expect(isAllowedWsOrigin('https://cockpit.internal', ['https://cockpit.internal'])).toBe(true);
    expect(isAllowedWsOrigin('https://other.internal', ['https://cockpit.internal'])).toBe(false);
  });

  it('rejects malformed Origin headers', () => {
    expect(isAllowedWsOrigin('not a url', [])).toBe(false);
  });
});
