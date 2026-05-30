import { describe, it, expect } from 'vitest';
import { isBlockedEgressIp, assertSafeChairUrl } from '../services/UrlEgressGuard.js';

describe('isBlockedEgressIp', () => {
  it('blocks link-local / cloud-metadata / unspecified', () => {
    expect(isBlockedEgressIp('169.254.169.254')).toBe(true); // IMDS
    expect(isBlockedEgressIp('169.254.0.1')).toBe(true);
    expect(isBlockedEgressIp('0.0.0.0')).toBe(true);
    expect(isBlockedEgressIp('::')).toBe(true);
    expect(isBlockedEgressIp('fe80::1')).toBe(true);
    expect(isBlockedEgressIp('::ffff:169.254.169.254')).toBe(true); // IPv4-mapped
  });

  it('allows loopback + public by default (loopback chairs must work)', () => {
    expect(isBlockedEgressIp('127.0.0.1')).toBe(false);
    expect(isBlockedEgressIp('::1')).toBe(false);
    expect(isBlockedEgressIp('8.8.8.8')).toBe(false);
    expect(isBlockedEgressIp('10.0.0.5')).toBe(false);
  });

  it('blocks private ranges only when blockPrivate is set', () => {
    const p = { blockPrivate: true };
    expect(isBlockedEgressIp('10.0.0.5', p)).toBe(true);
    expect(isBlockedEgressIp('192.168.1.1', p)).toBe(true);
    expect(isBlockedEgressIp('172.16.0.1', p)).toBe(true);
    expect(isBlockedEgressIp('fd00::1', p)).toBe(true);
    expect(isBlockedEgressIp('8.8.8.8', p)).toBe(false);
  });
});

describe('assertSafeChairUrl', () => {
  const noLookup = async () => {
    throw new Error('lookup should not run for IP literals');
  };

  it('rejects non-http(s) and malformed URLs', async () => {
    await expect(assertSafeChairUrl('file:///etc/passwd')).rejects.toThrow(/disallowed protocol/);
    await expect(assertSafeChairUrl('::::not a url')).rejects.toThrow(/valid URL/);
  });

  it('rejects a cloud-metadata IP literal without resolving', async () => {
    await expect(assertSafeChairUrl('http://169.254.169.254/latest/meta-data/', {}, noLookup))
      .rejects.toThrow(/blocked address/);
  });

  it('allows a loopback chair inbox', async () => {
    await expect(assertSafeChairUrl('http://127.0.0.1:8123/inbox', {}, noLookup)).resolves.toBeUndefined();
  });

  it('checks every resolved address (DNS-rebind defense)', async () => {
    const lookup = async () => [{ address: '169.254.169.254' }];
    await expect(assertSafeChairUrl('http://innocent.example/inbox', {}, lookup))
      .rejects.toThrow(/blocked address/);
  });

  it('allows a hostname resolving to a public address', async () => {
    const lookup = async () => [{ address: '93.184.216.34' }];
    await expect(assertSafeChairUrl('https://chair.example/inbox', {}, lookup)).resolves.toBeUndefined();
  });
});
