import { describe, it, expect } from 'vitest';
import { isBlockedEgressIp, resolveSafeChairUrl } from '../services/UrlEgressGuard.js';

describe('isBlockedEgressIp', () => {
  it('blocks link-local / cloud-metadata / unspecified (v4, v6, and v4-mapped)', () => {
    expect(isBlockedEgressIp('169.254.169.254')).toBe(true); // IMDS
    expect(isBlockedEgressIp('169.254.0.1')).toBe(true);
    expect(isBlockedEgressIp('0.0.0.0')).toBe(true);
    expect(isBlockedEgressIp('::')).toBe(true);
    expect(isBlockedEgressIp('fe80::1')).toBe(true);
    // IPv4-mapped IPv6 in BOTH renderings — the CRITICAL bypass the regex missed
    expect(isBlockedEgressIp('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedEgressIp('::ffff:a9fe:a9fe')).toBe(true);
  });

  it('allows loopback + public by default (loopback chairs must work)', () => {
    expect(isBlockedEgressIp('127.0.0.1')).toBe(false);
    expect(isBlockedEgressIp('::1')).toBe(false);
    expect(isBlockedEgressIp('::ffff:127.0.0.1')).toBe(false);
    expect(isBlockedEgressIp('8.8.8.8')).toBe(false);
    expect(isBlockedEgressIp('10.0.0.5')).toBe(false);
  });

  it('blocks private ranges only when blockPrivate is set', () => {
    const p = { blockPrivate: true };
    expect(isBlockedEgressIp('10.0.0.5', p)).toBe(true);
    expect(isBlockedEgressIp('192.168.1.1', p)).toBe(true);
    expect(isBlockedEgressIp('172.16.0.1', p)).toBe(true);
    expect(isBlockedEgressIp('fd00::1', p)).toBe(true);
    expect(isBlockedEgressIp('::ffff:10.0.0.5', p)).toBe(true);
    expect(isBlockedEgressIp('8.8.8.8', p)).toBe(false);
  });
});

describe('resolveSafeChairUrl', () => {
  const noLookup = async () => {
    throw new Error('lookup should not run for IP literals');
  };

  it('rejects non-http(s) and malformed URLs', async () => {
    await expect(resolveSafeChairUrl('file:///etc/passwd')).rejects.toThrow(/disallowed protocol/);
    await expect(resolveSafeChairUrl('::::bad')).rejects.toThrow(/valid URL/);
  });

  it('blocks the IPv4-mapped IPv6 metadata forms (the CRITICAL bypass)', async () => {
    for (const u of ['http://[::ffff:169.254.169.254]/', 'http://[::ffff:a9fe:a9fe]/']) {
      await expect(resolveSafeChairUrl(u, {}, noLookup), u).rejects.toThrow(/blocked address/);
    }
  });

  it('never allows alternate-encoded metadata through (fail-closed)', async () => {
    // Whatever the WHATWG URL parser does with these, none may resolve to an
    // allowed dispatch (normalized → blocked IP, or unresolvable host → reject).
    for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://0xA9FEA9FE/', 'http://2852039166/']) {
      await expect(resolveSafeChairUrl(u, {}, noLookup), u).rejects.toThrow();
    }
  });

  it('allows a loopback chair inbox unchanged', async () => {
    await expect(resolveSafeChairUrl('http://127.0.0.1:8123/inbox', {}, noLookup))
      .resolves.toBe('http://127.0.0.1:8123/inbox');
  });

  it('pins an http hostname to its validated IP (DNS-rebind TOCTOU defense)', async () => {
    const lookup = async () => [{ address: '93.184.216.34' }];
    await expect(resolveSafeChairUrl('http://chair.example/inbox', {}, lookup))
      .resolves.toBe('http://93.184.216.34/inbox');
  });

  it('rejects when any resolved address is blocked', async () => {
    const lookup = async () => [{ address: '169.254.169.254' }];
    await expect(resolveSafeChairUrl('http://rebind.example/inbox', {}, lookup)).rejects.toThrow(/blocked address/);
  });
});
