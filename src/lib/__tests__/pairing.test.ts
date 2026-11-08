import {
  buildPairingLink,
  normalizeCode,
  normalizeHubUrl,
  pairWithHub,
  parsePairingLink,
  PairingError,
  wsUrlFor,
  type FetchLike,
} from '../pairing';

const CONTRACT_EXAMPLE =
  'phiremote://pair?v=1&code=K7Q2M9XD&name=MY-MAC&hubId=hub-1&url=http%3A%2F%2F192.0.2.10%3A7717&url=http%3A%2F%2Fmy-mac.local%3A7717';

describe('parsePairingLink', () => {
  it('parses the contract example with repeated url params in order', () => {
    const r = parsePairingLink(CONTRACT_EXAMPLE);
    expect(r).toEqual({
      ok: true,
      value: {
        version: 1,
        code: 'K7Q2M9XD',
        name: 'MY-MAC',
        hubId: 'hub-1',
        urls: ['http://192.0.2.10:7717', 'http://my-mac.local:7717'],
      },
    });
  });

  it('accepts the router path form and triple-slash form', () => {
    const q = 'v=1&code=k7q2m9xd&url=http%3A%2F%2F192.0.2.10%3A7717';
    for (const s of [`/pair?${q}`, `phiremote:///pair?${q}`, `pair?${q}`]) {
      const r = parsePairingLink(s);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.code).toBe('K7Q2M9XD');
    }
  });

  it('round-trips through buildPairingLink', () => {
    const link = { code: 'ABCD1234', name: 'box', hubId: 'h', urls: ['http://a:7717', 'https://b.example'] };
    const r = parsePairingLink(buildPairingLink(link));
    expect(r).toEqual({ ok: true, value: { version: 1, ...link } });
  });

  it('rejects other links, bad codes, newer versions, and links without urls', () => {
    expect(parsePairingLink('https://example.com').ok).toBe(false);
    expect(parsePairingLink('phiremote://session/a/b').ok).toBe(false);
    expect(parsePairingLink('phiremote://pair?v=1&code=SHORT&url=http%3A%2F%2Fa').ok).toBe(false);
    expect(parsePairingLink('phiremote://pair?v=2&code=K7Q2M9XD&url=http%3A%2F%2Fa').ok).toBe(false);
    expect(parsePairingLink('phiremote://pair?v=1&code=K7Q2M9XD').ok).toBe(false);
    expect(parsePairingLink('phiremote://pair?v=1&code=K7Q2M9XD&url=ftp%3A%2F%2Fa').ok).toBe(false);
  });

  it('skips duplicate and invalid urls but keeps valid ones', () => {
    const r = parsePairingLink(
      'phiremote://pair?code=K7Q2M9XD&url=http%3A%2F%2Fa%3A7717&url=nonsense%20url&url=http%3A%2F%2Fa%3A7717',
    );
    expect(r.ok && r.value.urls).toEqual(['http://a:7717']);
  });
});

describe('normalizeCode', () => {
  it('is case-insensitive and ignores separators', () => {
    expect(normalizeCode('k7q2-m9xd')).toBe('K7Q2M9XD');
    expect(normalizeCode(' K7Q2 M9XD ')).toBe('K7Q2M9XD');
  });
  it('reads I/L as 1 and O as 0 (Crockford)', () => {
    expect(normalizeCode('ILO23456')).toBe('11023456');
  });
  it('rejects U, wrong lengths and symbols', () => {
    expect(normalizeCode('UUUUUUUU')).toBeNull();
    expect(normalizeCode('ABC')).toBeNull();
    expect(normalizeCode('ABCDEFGHJ')).toBeNull();
    expect(normalizeCode('ABCD!234')).toBeNull();
  });
});

describe('normalizeHubUrl', () => {
  it.each([
    ['192.0.2.10', 'http://192.0.2.10:7717'],
    ['192.0.2.10:9000', 'http://192.0.2.10:9000'],
    ['my-mac.local', 'http://my-mac.local:7717'],
    ['http://192.0.2.10:7717/', 'http://192.0.2.10:7717'],
    ['HTTP://Box.Local:7717', 'http://box.local:7717'],
    ['https://phi.example.com', 'https://phi.example.com'],
    ['ws://192.0.2.11:7717', 'http://192.0.2.11:7717'],
    ['[fd7a:115c::1]', 'http://[fd7a:115c::1]:7717'],
    ['http://host:7717/prefix/', 'http://host:7717/prefix'],
  ])('%s → %s', (input, out) => {
    expect(normalizeHubUrl(input)).toBe(out);
  });

  it.each(['', '   ', 'ftp://x', 'http://', 'a b', 'user@host', 'fd7a::1'])('rejects %p', (input) => {
    expect(normalizeHubUrl(input)).toBeNull();
  });

  it('derives the websocket url', () => {
    expect(wsUrlFor('http://192.0.2.10:7717')).toBe('ws://192.0.2.10:7717/v1/ws');
    expect(wsUrlFor('https://a.b/')).toBe('wss://a.b/v1/ws');
  });
});

type Route = (init?: { method?: string; body?: string }) => Promise<{ status: number; body: unknown }> | 'hang';

function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    const route = routes[`${init?.method ?? 'GET'} ${url}`];
    if (!route) return Promise.reject(new TypeError('Network request failed'));
    const r = route(init);
    if (r === 'hang') return new Promise(() => undefined);
    return r.then(({ status, body }) => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
  };
  return { fetch, calls };
}

const info = (hubId: string, protocol = 1) => async () => ({
  status: 200,
  body: { name: 'MY-MAC', hubId, hubVersion: '0.1.0', protocol },
});

describe('pairWithHub', () => {
  afterEach(() => jest.useRealTimers());

  it('probes urls in order, skips unreachable and mismatched hubs, then pairs with the match', async () => {
    jest.useFakeTimers();
    const { fetch, calls } = fakeFetch({
      'GET http://a:7717/v1/info': () => 'hang',
      'GET http://b:7717/v1/info': info('someone-else'),
      'GET http://c:7717/v1/info': info('hub-1'),
      'POST http://c:7717/v1/pair': async () => ({
        status: 200,
        body: { deviceId: 'dev-9', token: 'secret', hubId: 'hub-1', name: 'MY-MAC' },
      }),
    });
    const p = pairWithHub(
      { urls: ['http://a:7717', 'http://b:7717', 'http://c:7717'], code: 'k7q2m9xd', hubId: 'hub-1', deviceName: 'iPhone' },
      { fetch, now: () => 123 },
    );
    await jest.advanceTimersByTimeAsync(2500);
    await expect(p).resolves.toEqual({
      hubId: 'hub-1',
      name: 'MY-MAC',
      urls: ['http://a:7717', 'http://b:7717', 'http://c:7717'],
      preferredUrl: 'http://c:7717',
      deviceId: 'dev-9',
      token: 'secret',
      pairedAt: 123,
    });
    const post = calls.find((c) => c.method === 'POST');
    expect(JSON.parse(post!.body!)).toEqual({ code: 'K7Q2M9XD', deviceName: 'iPhone', platform: 'ios' });
  });

  it('accepts any hub for manual entry without a hubId', async () => {
    const { fetch } = fakeFetch({
      'GET http://a:7717/v1/info': info('hub-x'),
      'POST http://a:7717/v1/pair': async () => ({ status: 200, body: { deviceId: 'd', token: 't', hubId: 'hub-x', name: 'box' } }),
    });
    const host = await pairWithHub({ urls: ['a'], code: 'ABCD1234', deviceName: 'iPhone' }, { fetch });
    expect(host.hubId).toBe('hub-x');
    expect(host.preferredUrl).toBe('http://a:7717');
  });

  it.each([
    [401, 'invalid_code'],
    [429, 'rate_limited'],
    [500, 'bad_response'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const { fetch } = fakeFetch({
      'GET http://a:7717/v1/info': info('h'),
      'POST http://a:7717/v1/pair': async () => ({ status, body: { error: 'x' } }),
    });
    await expect(pairWithHub({ urls: ['http://a:7717'], code: 'ABCD1234', deviceName: 'p' }, { fetch })).rejects.toMatchObject({
      code,
    });
  });

  it('reports unreachable, mismatch and protocol errors', async () => {
    const none = fakeFetch({});
    await expect(
      pairWithHub({ urls: ['http://a:7717'], code: 'ABCD1234', deviceName: 'p' }, { fetch: none.fetch }),
    ).rejects.toMatchObject({ code: 'unreachable' });

    const other = fakeFetch({ 'GET http://a:7717/v1/info': info('nope') });
    await expect(
      pairWithHub({ urls: ['http://a:7717'], code: 'ABCD1234', hubId: 'want', deviceName: 'p' }, { fetch: other.fetch }),
    ).rejects.toMatchObject({ code: 'hub_mismatch' });

    const newer = fakeFetch({ 'GET http://a:7717/v1/info': info('h', 2) });
    await expect(
      pairWithHub({ urls: ['http://a:7717'], code: 'ABCD1234', deviceName: 'p' }, { fetch: newer.fetch }),
    ).rejects.toMatchObject({ code: 'incompatible' });
  });

  it('rejects malformed codes before any network call', async () => {
    const { fetch, calls } = fakeFetch({});
    await expect(pairWithHub({ urls: ['http://a'], code: 'nope', deviceName: 'p' }, { fetch })).rejects.toBeInstanceOf(
      PairingError,
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects a pair reply without a token', async () => {
    const { fetch } = fakeFetch({
      'GET http://a:7717/v1/info': info('h'),
      'POST http://a:7717/v1/pair': async () => ({ status: 200, body: { deviceId: 'd' } }),
    });
    await expect(pairWithHub({ urls: ['http://a:7717'], code: 'ABCD1234', deviceName: 'p' }, { fetch })).rejects.toMatchObject({
      code: 'bad_response',
    });
  });
});
