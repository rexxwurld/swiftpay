// tests/ssrfGuard.test.js
const { isDisallowedIp } = require('../src/utils/ssrfGuard');

describe('isDisallowedIp', () => {
  describe('IPv4', () => {
    it('blocks loopback', () => {
      expect(isDisallowedIp('127.0.0.1')).toBe(true);
      expect(isDisallowedIp('127.255.255.255')).toBe(true);
    });

    it('blocks the 10.0.0.0/8 private range', () => {
      expect(isDisallowedIp('10.0.0.1')).toBe(true);
      expect(isDisallowedIp('10.255.255.255')).toBe(true);
    });

    it('blocks the 172.16.0.0/12 private range but not neighboring public ranges', () => {
      expect(isDisallowedIp('172.16.0.1')).toBe(true);
      expect(isDisallowedIp('172.31.255.255')).toBe(true);
      expect(isDisallowedIp('172.15.255.255')).toBe(false); // just outside the private range
      expect(isDisallowedIp('172.32.0.0')).toBe(false); // just outside the private range
    });

    it('blocks the 192.168.0.0/16 private range', () => {
      expect(isDisallowedIp('192.168.1.1')).toBe(true);
    });

    it('blocks 169.254.0.0/16 (link-local / cloud metadata endpoint range)', () => {
      // 169.254.169.254 is the AWS/GCP/Azure instance-metadata IP - a
      // classic SSRF target for stealing cloud credentials.
      expect(isDisallowedIp('169.254.169.254')).toBe(true);
    });

    it('allows ordinary public IPs', () => {
      expect(isDisallowedIp('8.8.8.8')).toBe(false);
      expect(isDisallowedIp('93.184.216.34')).toBe(false);
    });
  });

  describe('IPv6', () => {
    it('blocks loopback (::1)', () => {
      expect(isDisallowedIp('::1')).toBe(true);
    });

    it('blocks link-local (fe80::/10)', () => {
      expect(isDisallowedIp('fe80::1')).toBe(true);
    });

    it('blocks unique local addresses (fc00::/7)', () => {
      expect(isDisallowedIp('fd12:3456:789a::1')).toBe(true);
    });

    it('unwraps IPv4-mapped IPv6 addresses and checks the embedded IPv4', () => {
      expect(isDisallowedIp('::ffff:127.0.0.1')).toBe(true);
      expect(isDisallowedIp('::ffff:8.8.8.8')).toBe(false);
    });

    it('allows an ordinary public IPv6 address', () => {
      expect(isDisallowedIp('2001:4860:4860::8888')).toBe(false); // Google public DNS
    });
  });

  it('treats non-IP input as disallowed rather than guessing', () => {
    expect(isDisallowedIp('not-an-ip')).toBe(true);
  });
});

describe('assertSafeWebhookUrl', () => {
  // dns.lookup is mocked per-test so these run fully offline and
  // deterministically, rather than depending on real DNS resolution.
  let assertSafeWebhookUrl;
  let mockLookup;

  beforeEach(() => {
    jest.resetModules();
    mockLookup = jest.fn();
    jest.doMock('dns', () => ({
      promises: { lookup: mockLookup },
    }));
    ({ assertSafeWebhookUrl } = require('../src/utils/ssrfGuard'));
  });

  afterEach(() => {
    jest.dontMock('dns');
  });

  it('rejects a hostname that resolves to a private IP', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(assertSafeWebhookUrl('https://internal.example.com/hook')).rejects.toThrow('webhook_url_not_allowed');
  });

  it('accepts a hostname that resolves to a public IP', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(assertSafeWebhookUrl('https://public.example.com/hook')).resolves.toBeUndefined();
  });

  it('rejects if ANY resolved address is private (multi-A-record DNS-rebinding-style attempt)', async () => {
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(assertSafeWebhookUrl('https://mixed.example.com/hook')).rejects.toThrow('webhook_url_not_allowed');
  });

  it('rejects a bare private IP literal without doing a DNS lookup at all', async () => {
    await expect(assertSafeWebhookUrl('https://127.0.0.1/hook')).rejects.toThrow('webhook_url_not_allowed');
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('rejects non-http(s) protocols', async () => {
    await expect(assertSafeWebhookUrl('ftp://example.com/hook')).rejects.toThrow('invalid_webhook_url');
  });

  it('rejects malformed URLs', async () => {
    await expect(assertSafeWebhookUrl('not a url')).rejects.toThrow('invalid_webhook_url');
  });

  it('rejects localhost and .localhost hostnames outright', async () => {
    await expect(assertSafeWebhookUrl('https://localhost/hook')).rejects.toThrow('webhook_url_not_allowed');
    await expect(assertSafeWebhookUrl('https://foo.localhost/hook')).rejects.toThrow('webhook_url_not_allowed');
    expect(mockLookup).not.toHaveBeenCalled();
  });
});
