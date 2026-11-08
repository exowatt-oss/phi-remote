import {
  ConnTrace,
  describeEvent,
  formatDuration,
  formatTraceReport,
  parseTraceFile,
  TRACE_FILE,
  TRACE_LIMIT,
  traceRows,
  type TraceEvent,
} from '../conn-trace';
import { MemoryFiles } from '../history-cache';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const at = (h: number, m: number, s: number, ms = 0, day = 4) => new Date(2026, 10, day, h, m, s, ms).getTime();

describe('ConnTrace ring buffer', () => {
  it('keeps the newest TRACE_LIMIT events per computer, oldest first', () => {
    const trace = new ConnTrace();
    for (let i = 0; i < TRACE_LIMIT + 50; i++) trace.record('hub-a', { at: i, kind: 'attempt', text: `#${i}` });
    trace.record('hub-b', { at: 1, kind: 'launch' });
    const a = trace.events('hub-a');
    expect(a).toHaveLength(TRACE_LIMIT);
    expect(a[0].text).toBe('#50');
    expect(a[a.length - 1].text).toBe(`#${TRACE_LIMIT + 49}`);
    expect(trace.events('hub-b')).toHaveLength(1);
  });

  it('honours a custom bound and records one event in every log', () => {
    const trace = new ConnTrace({ limit: 3, now: () => 42 });
    trace.recordAll(['a', 'b'], { kind: 'network', text: 'wifi' });
    for (let i = 0; i < 5; i++) trace.record('a', { kind: 'retry', ms: i });
    expect(trace.events('a').map((e) => e.ms)).toEqual([2, 3, 4]);
    expect(trace.events('b')).toEqual([{ at: 42, kind: 'network', text: 'wifi' }]);
  });

  it('notifies listeners and bumps its version on every change', () => {
    const trace = new ConnTrace();
    const seen: number[] = [];
    const off = trace.subscribe(() => seen.push(trace.version));
    trace.record('a', { kind: 'launch' });
    trace.removeHub('a');
    off();
    trace.record('a', { kind: 'launch' });
    expect(seen).toEqual([1, 2]);
  });

  it('forgets computers that are no longer paired', () => {
    const trace = new ConnTrace();
    trace.record('a', { kind: 'launch' });
    trace.record('b', { kind: 'launch' });
    trace.retain(['b']);
    expect(trace.hubIds()).toEqual(['b']);
  });
});

describe('ConnTrace persistence', () => {
  it('saves after a short delay and loads it back on the next launch', async () => {
    const files = new MemoryFiles();
    const first = new ConnTrace({ files, saveDelayMs: 1_000 });
    await first.load();
    first.record('hub-a', { at: 10, kind: 'attempt', url: 'http://192.0.2.10:7717' });
    first.record('hub-a', { at: 20, kind: 'fail', url: 'http://192.0.2.10:7717', ms: 8_000, text: 'Timed out connecting' });
    expect(files.data.has(TRACE_FILE)).toBe(false);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(files.data.has(TRACE_FILE)).toBe(true);

    // Next launch: events recorded before the file is read stay after the saved ones.
    const second = new ConnTrace({ files });
    second.record('hub-a', { at: 30, kind: 'launch' });
    await second.load();
    expect(second.events('hub-a').map((e) => e.kind)).toEqual(['attempt', 'fail', 'launch']);
    expect(second.events('hub-a')[1]).toEqual({ at: 20, kind: 'fail', url: 'http://192.0.2.10:7717', ms: 8_000, text: 'Timed out connecting' });
  });

  it('stays bounded across launches', async () => {
    const files = new MemoryFiles();
    const first = new ConnTrace({ files, limit: 5 });
    await first.load();
    for (let i = 0; i < 5; i++) first.record('a', { at: i, kind: 'retry', ms: i });
    await first.flush();
    const second = new ConnTrace({ files, limit: 5 });
    for (let i = 10; i < 13; i++) second.record('a', { at: i, kind: 'retry', ms: i });
    await second.load();
    expect(second.events('a').map((e) => e.at)).toEqual([3, 4, 10, 11, 12]);
  });

  it('flushes at once (app going to the background)', async () => {
    const files = new MemoryFiles();
    const trace = new ConnTrace({ files, saveDelayMs: 60_000 });
    await trace.load();
    trace.record('a', { kind: 'background' });
    await trace.flush();
    expect(parseTraceFile(files.data.get(TRACE_FILE) ?? null).a).toHaveLength(1);
  });

  it('reads a broken or foreign file as empty and drops bad events', () => {
    expect(parseTraceFile(null)).toEqual({});
    expect(parseTraceFile('{nope')).toEqual({});
    expect(parseTraceFile(JSON.stringify({ v: 2, hubs: {} }))).toEqual({});
    const raw = JSON.stringify({
      v: 1,
      hubs: {
        a: [{ at: 2, kind: 'welcome', ms: 120 }, { at: 'x', kind: 'fail' }, { at: 1, kind: 'mystery' }, { at: 1, kind: 'attempt', code: 'no' }],
        b: 'not a list',
      },
    });
    expect(parseTraceFile(raw)).toEqual({ a: [{ at: 1, kind: 'attempt' }, { at: 2, kind: 'welcome', ms: 120 }] });
  });
});

describe('reading the log', () => {
  it('formats durations', () => {
    expect(formatDuration(412)).toBe('412 ms');
    expect(formatDuration(8_000)).toBe('8.0 s');
    expect(formatDuration(123_000)).toBe('2m 03s');
    expect(formatDuration(3_725_000)).toBe('1h 02m');
  });

  it('describes each kind of event in one plain line', () => {
    const url = 'http://my-mac.local:7717';
    expect(describeEvent({ at: 0, kind: 'attempt', url, text: 'round 3, 1/2 · backoff over' })).toBe(
      'connecting my-mac.local:7717 · round 3, 1/2 · backoff over',
    );
    expect(describeEvent({ at: 0, kind: 'fail', url, ms: 8_003, text: 'Timed out connecting' })).toBe(
      'failed my-mac.local:7717 · 8.0 s · Timed out connecting',
    );
    expect(describeEvent({ at: 0, kind: 'fail', url, ms: 40, code: 1006, text: "Couldn't reach the computer" })).toBe(
      "failed my-mac.local:7717 · 40 ms · code 1006 · Couldn't reach the computer",
    );
    expect(describeEvent({ at: 0, kind: 'retry', ms: 2_000, text: 'step 4' })).toBe('retry in 2.0 s · step 4');
    expect(describeEvent({ at: 0, kind: 'welcome', url, ms: 182 })).toBe('live my-mac.local:7717 · 182 ms');
    expect(describeEvent({ at: 0, kind: 'network', text: 'cellular' })).toBe('network · cellular');
  });

  it('lists newest first, with a day line when the log spans days', () => {
    const one: TraceEvent[] = [
      { at: at(16, 28, 38, 274), kind: 'attempt', url: 'http://a:1' },
      { at: at(16, 28, 46, 280), kind: 'fail', url: 'http://a:1', ms: 8_006, text: 'Timed out connecting' },
    ];
    expect(traceRows(one).map((r) => r.line)).toEqual([
      '16:28:46.280  failed a:1 · 8.0 s · Timed out connecting',
      '16:28:38.274  connecting a:1',
    ]);
    const two: TraceEvent[] = [{ at: at(23, 59, 59, 0, 3), kind: 'launch' }, ...one];
    expect(traceRows(two).map((r) => r.line)).toEqual([
      '2026-11-04',
      '16:28:46.280  failed a:1 · 8.0 s · Timed out connecting',
      '16:28:38.274  connecting a:1',
      '2026-11-03',
      '23:59:59.000  app started',
    ]);
  });

  it('copies every computer with the app version, build and time, oldest first', () => {
    const text = formatTraceReport({
      app: { version: '0.1.0', build: '263082117' },
      now: at(16, 40, 12, 5),
      device: 'iPhone, iOS 26.1',
      hosts: [
        {
          hubId: 'hub-a',
          name: 'MY-MAC',
          status: 'Live',
          urls: ['http://my-mac.local:7717', 'http://192.0.2.10:7717'],
          events: [
            { at: at(16, 28, 38, 274), kind: 'attempt', url: 'http://192.0.2.10:7717' },
            { at: at(16, 30, 42, 990), kind: 'welcome', url: 'http://192.0.2.10:7717', ms: 140 },
          ],
        },
        { hubId: 'hub-b', name: 'laptop-test', status: 'Offline', urls: [], events: [] },
      ],
    });
    expect(text).toContain('phi remote connection log\nApp 0.1.0 (263082117) on iPhone, iOS 26.1\nCopied 2026-11-04 16:40:12.005');
    expect(text).toContain('== MY-MAC (hub-a) · Live\nAddresses: my-mac.local:7717, 192.0.2.10:7717\n-- 2026-11-04\n16:28:38.274  connecting 192.0.2.10:7717\n16:30:42.990  live 192.0.2.10:7717 · 140 ms');
    expect(text).toContain('== laptop-test (hub-b) · Offline\nAddresses: none\n(no events)');
  });
});
