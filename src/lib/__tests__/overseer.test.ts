/**
 * Overseers (v1 addition): parsing, the board, nesting on the lists, counts, the prompts that
 * start an overseer or a thread, and the transcript cards, on shapes taken from real phi
 * 1.4.0-exo.11 overseer sessions (overseer tool results, overseer_event messages, agent mail).
 */

import { buildFeed } from '../feed';
import { nestHistory, sectionize, type HistoryRow } from '../history';
import {
  activeThreads,
  addThreadPrompt,
  boardGroups,
  countBoard,
  countLive,
  countSegments,
  countsLine,
  DEFAULT_OVERSEER,
  defaultsLines,
  describeOverseerDefaults,
  eventSummary,
  formatCost,
  mergeBoard,
  nestUnderOverseers,
  overseerCall,
  overseerCommand,
  overseerEvents,
  overseerName,
  overseerPrompt,
  parseBoard,
  parseOverseerDefaults,
  PLAIN_OVERSEER_LEAD,
  prettyModel,
  STALL_MS,
  threadDetail,
  threadIdByName,
  threadModelLabel,
  threadOfCaption,
  threadReport,
  threadState,
  type BoardThread,
} from '../overseer';
import { parsePastSession, parseServerFrame, parseSessionSummary, type CommandInfo, type NoteItem, type SessionSummary, type ToolItem, type TranscriptItem } from '../protocol';
import { groupByProject, type HostView } from '../store';

const OV = '0f5e7a3c-2b1d-4e6f-8a9b-1c2d3e4f5a6b';
const NOW = 1_800_000_000_000;

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 's1',
    name: 'Fix the build',
    cwd: '/Users/f/ExampleCo/phi',
    host: 'mac',
    pid: 1,
    kind: 'interactive',
    status: 'idle',
    startedAt: 1_000,
    lastActivityAt: 2_000,
    ...over,
  };
}

function thread(over: Partial<BoardThread> = {}): BoardThread {
  return { name: 't', sessionId: 't1', backend: 'headless', cwd: '/x', state: 'running', live: true, status: 'idle', createdAt: 1, ...over };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parsing', () => {
  it('reads overseer fields on summaries, drops them on subagents', () => {
    const s = parseSessionSummary({
      ...summary(),
      overseer: { sessionId: OV, name: 'Overseer · x', thread: 'api' },
      lastError: '429 rate limited',
      isOverseer: true,
      threadCounts: { total: 4, working: 1, idle: 2, error: 1, exited: 0, closed: 0 },
    });
    expect(s?.overseer).toEqual({ sessionId: OV, name: 'Overseer · x', thread: 'api' });
    expect(s?.lastError).toBe('429 rate limited');
    expect(s?.isOverseer).toBe(true);
    expect(s?.threadCounts).toEqual({ total: 4, working: 1, idle: 2, error: 1, exited: 0, closed: 0 });
    // Older hubs (exo.10): none of it.
    const old = parseSessionSummary(summary());
    expect(old && 'overseer' in old).toBe(false);
    expect(old?.isOverseer).toBeUndefined();
    // Junk is ignored, not fatal.
    const junk = parseSessionSummary({ ...summary(), overseer: { name: 'no id' }, isOverseer: 'yes', threadCounts: { total: 0 } });
    expect(junk?.overseer).toBeUndefined();
    expect(junk?.isOverseer).toBeUndefined();
    expect(junk?.threadCounts).toBeUndefined();
    const sub = parseSessionSummary({
      ...summary({ sessionId: 'p~sa~r1', kind: 'subagent' }),
      parentSessionId: 'p',
      subagent: { runId: 'r1', toolCallId: 'c', index: 0, task: 'x', status: 'running', startedAt: 1 },
      overseer: { sessionId: OV },
      isOverseer: true,
    });
    expect(sub?.overseer).toBeUndefined();
    expect(sub?.isOverseer).toBeUndefined();
  });

  it('reads PastSession.overseer and isOverseer', () => {
    const p = parsePastSession({ sessionId: 'a', title: 'deps-api', named: true, cwd: '/x', createdAt: 1, modifiedAt: 2, messageCount: 3, overseer: { sessionId: OV, thread: 'deps-api' } });
    expect(p?.overseer).toEqual({ sessionId: OV, thread: 'deps-api' });
    const o = parsePastSession({ sessionId: OV, title: 'Overseer', named: true, cwd: '/x', createdAt: 1, modifiedAt: 2, messageCount: 3, isOverseer: true });
    expect(o?.isOverseer).toBe(true);
  });

  it('parses overseer.board, skipping bad and duplicate threads', () => {
    const f = parseServerFrame({
      t: 'overseer.board',
      re: 'q1',
      sessionId: OV,
      name: 'Overseer · ship it',
      threads: [
        { name: 'api', sessionId: 'a', backend: 'forca', cwd: '/x', model: 'anthropic/claude-opus-5-5', thinking: 'high', state: 'running', live: true, status: 'working', activity: 'bash npm test', costUsd: 1.37, createdAt: 1 },
        { name: 'nope' },
        { name: 'api again', sessionId: 'a', backend: 'forca', cwd: '/x', state: 'running', live: true, createdAt: 2 },
        { name: 'docs', sessionId: 'd', backend: 'weird', cwd: '/x', state: 'closed', live: false, createdAt: 3, closedAt: 9 },
      ],
    });
    expect(f).toMatchObject({ t: 'overseer.board', re: 'q1', sessionId: OV, name: 'Overseer · ship it' });
    const board = f as Extract<typeof f, { t: 'overseer.board' }>;
    expect(board.threads.map((t) => [t.name, t.backend, t.state, t.live])).toEqual([
      ['api', 'forca', 'running', true],
      ['docs', 'headless', 'closed', false],
    ]);
    expect(parseServerFrame({ t: 'overseer.board', sessionId: OV, threads: [] })).toBeNull(); // no re
    expect(parseBoard({ threads: [] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Board: state, merge, counts
// ---------------------------------------------------------------------------

describe('board', () => {
  it('derives each thread state; live status beats registry state', () => {
    expect(threadState(thread({ status: 'working', lastActivityAt: NOW - 1000 }), NOW)).toBe('working');
    expect(threadState(thread({ status: 'working', lastActivityAt: NOW - STALL_MS - 1 }), NOW)).toBe('stalled');
    expect(threadState(thread({ lastError: '429' }), NOW)).toBe('error');
    expect(threadState(thread({ status: 'working', lastError: 'old' }), NOW)).toBe('working');
    expect(threadState(thread(), NOW)).toBe('idle');
    expect(threadState(thread({ live: false, state: 'exited', status: undefined }), NOW)).toBe('exited');
    expect(threadState(thread({ live: false, state: 'running', status: undefined }), NOW)).toBe('exited');
    expect(threadState(thread({ live: false, state: 'closed' }), NOW)).toBe('closed');
    // A closed record whose session still runs (an adopted thread it stopped watching) is live.
    expect(threadState(thread({ live: true, state: 'closed', status: 'working', lastActivityAt: NOW }), NOW)).toBe('working');
  });

  it('lays live summaries over the hub board and appends unlisted live threads', () => {
    const board = parseBoard({
      sessionId: OV,
      threads: [
        { name: 'api', sessionId: 'a', backend: 'forca', cwd: '/x', state: 'running', live: true, status: 'idle', lastText: 'old', createdAt: 1 },
        { name: 'docs', sessionId: 'd', backend: 'headless', cwd: '/x', state: 'closed', live: false, lastText: 'Updated 6 pages', createdAt: 2 },
      ],
    });
    const sessions = {
      a: summary({ sessionId: 'a', startedAt: 1, status: 'working', activity: { tool: 'bash', summary: 'npm test' }, lastText: 'new', usage: { costUsd: 1.5 }, overseer: { sessionId: OV, thread: 'api' } }),
      late: summary({ sessionId: 'late', name: 'phone thread', startedAt: 5, overseer: { sessionId: OV, thread: 'late-one' } }),
      other: summary({ sessionId: 'other' }),
    };
    const merged = mergeBoard(board, sessions, OV);
    expect(merged.map((t) => [t.name, t.status, t.activity, t.lastText, t.costUsd])).toEqual([
      ['api', 'working', 'bash  npm test', 'new', 1.5],
      ['docs', undefined, undefined, 'Updated 6 pages', undefined],
      ['late-one', 'idle', undefined, undefined, undefined],
    ]);
    // Older hub: derived from live summaries alone.
    expect(mergeBoard(null, sessions, OV).map((t) => t.sessionId)).toEqual(['a', 'late']);
    // A live summary clears the board's stale lastError.
    const fixed = mergeBoard(parseBoard({ sessionId: OV, threads: [{ name: 'm', sessionId: 'm', backend: 'headless', cwd: '/x', state: 'running', live: true, lastError: '429', createdAt: 1 }] }), { m: summary({ sessionId: 'm' }) }, OV);
    expect(fixed[0].lastError).toBeUndefined();
  });

  it('counts the way the rows read, and says what needs a look', () => {
    const threads = [
      thread({ sessionId: 'a', status: 'working', lastActivityAt: NOW }),
      thread({ sessionId: 'b', status: 'working', lastActivityAt: NOW }),
      thread({ sessionId: 'c', lastError: '429' }),
      thread({ sessionId: 'd' }),
      thread({ sessionId: 'e', live: false, state: 'closed', status: undefined }),
    ];
    const c = countBoard(threads, NOW);
    expect(c).toEqual({ total: 5, working: 2, stalled: 0, idle: 1, error: 1, exited: 0, closed: 1 });
    expect(countsLine(c)).toBe('5 threads · 2 working · 1 error');
    expect(countSegments(c)[2]).toEqual({ text: '1 error', tone: 'danger' });
    expect(countsLine({ total: 4, working: 0, idle: 3, error: 0, exited: 0, closed: 1 })).toBe('4 threads · 3 idle');
    expect(countsLine({ total: 2, working: 0, idle: 0, error: 0, exited: 0, closed: 2 })).toBe('2 threads · all closed');
    expect(countsLine({ total: 2, working: 0, idle: 0, error: 0, exited: 1, closed: 1 })).toBe('2 threads · ended');
    expect(countsLine({ total: 1, working: 0, stalled: 1, idle: 0, error: 0, exited: 0, closed: 0 })).toBe('1 thread · 1 stalled');
    expect(countLive([summary({ status: 'working' }), summary({ lastError: 'x' }), summary()])).toEqual({ total: 3, working: 1, idle: 1, error: 1, exited: 0, closed: 0 });
    expect(countLive([])).toBeUndefined();
  });

  it('groups the full board and keeps ended threads off the pinned one', () => {
    const threads = [
      thread({ sessionId: 'idle', name: 'idle' }),
      thread({ sessionId: 'work', name: 'work', status: 'working', lastActivityAt: NOW }),
      thread({ sessionId: 'err', name: 'err', lastError: 'x' }),
      thread({ sessionId: 'gone', name: 'gone', live: false, state: 'exited', status: undefined }),
      thread({ sessionId: 'shut', name: 'shut', live: false, state: 'closed', status: undefined }),
    ];
    expect(boardGroups(threads, NOW).map((g) => [g.title, g.threads.map((t) => t.name)])).toEqual([
      ['Needs a look', ['err']],
      ['Running', ['work', 'idle']],
      ['Exited', ['gone']],
      ['Closed', ['shut']],
    ]);
    expect(activeThreads(threads, NOW).map((t) => t.name)).toEqual(['work', 'err', 'idle']);
  });

  it('labels rows: model, detail, cost, and finds threads by name', () => {
    expect(prettyModel('anthropic/claude-opus-5-5')).toBe('Opus 5.5');
    expect(prettyModel('anthropic/claude-sonnet-5:medium')).toBe('Sonnet 5');
    expect(prettyModel('anthropic/claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(prettyModel('example/fast')).toBe('Fast');
    expect(prettyModel('openai/gpt-5.6')).toBe('GPT-5.6');
    expect(threadModelLabel({ model: 'anthropic/claude-opus-5-5', thinking: 'high' })).toBe('Opus 5.5 · high');
    expect(threadModelLabel({ model: 'example/fast:max' })).toBe('Fast · max');
    expect(formatCost(0.36)).toBe('$0.36');
    expect(formatCost(0.001)).toBe('<$0.01');
    expect(formatCost(undefined)).toBeNull();
    expect(formatCost(0)).toBeNull();
    const t = thread({ status: 'working', activity: 'bash  npm test', lastText: 'x', lastActivityAt: NOW });
    expect(threadDetail(t, 'working')).toEqual({ text: 'bash  npm test', tone: 'activity' });
    expect(threadDetail(thread({ lastError: '429', lastText: 'x' }), 'error')).toEqual({ text: '429', tone: 'danger' });
    expect(threadDetail(thread({ lastText: 'Done.' }), 'idle')).toEqual({ text: 'Done.', tone: 'plain' });
    const list = [thread({ name: 'api', sessionId: '1a2b3c4d-5e6f' }), thread({ name: 'ui', sessionId: '2b3c' })];
    expect(threadIdByName(list, 'api')).toBe('1a2b3c4d-5e6f');
    expect(threadIdByName(list, '1a2b3c4d')).toBe('1a2b3c4d-5e6f');
    expect(threadIdByName(list, 'nope')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Nesting on the lists
// ---------------------------------------------------------------------------

const hostView = (hubId: string): HostView => ({
  hubId,
  name: hubId,
  urls: [],
  preferredUrl: '',
  deviceId: 'd',
  pairedAt: 0,
  lastSeenAt: null,
  conn: { status: 'live', attempt: 0, url: null, lastError: null, nextRetryAt: null } as unknown as HostView['conn'],
  features: ['overseer'],
});

describe('nesting', () => {
  it('nests live threads under their overseer, across folders, never as rows of their own', () => {
    const link = { sessionId: OV, name: 'Overseer · ship it' };
    const sessions = {
      [OV]: summary({ sessionId: OV, name: 'Overseer · ship it', cwd: '/Users/f/ExampleCo', lastActivityAt: 10, isOverseer: true }),
      a: summary({ sessionId: 'a', cwd: '/Users/f/ExampleCo/api', startedAt: 2, lastActivityAt: 50, status: 'working', overseer: { ...link, thread: 'api' } }),
      b: summary({ sessionId: 'b', cwd: '/Users/f/ExampleCo', startedAt: 1, lastActivityAt: 5, overseer: { ...link, thread: 'ui' } }),
      orphan: summary({ sessionId: 'orphan', cwd: '/Users/f/ExampleCo/api', lastActivityAt: 7, overseer: { sessionId: 'gone', name: 'Overseer · old' } }),
      plain: summary({ sessionId: 'plain', cwd: '/Users/f/ExampleCo', lastActivityAt: 20 }),
    };
    const groups = groupByProject({ hostOrder: ['h'], hosts: { h: hostView('h') }, sessions: { h: sessions } });
    const top = groups.flatMap((g) => g.sessions.map((s) => s.sessionId));
    expect(top.sort()).toEqual([OV, 'orphan', 'plain'].sort());
    const home = groups.find((g) => g.cwd === '/Users/f/ExampleCo')!;
    // The overseer sorts as working (a thread works) and as recent as its busiest thread.
    expect(home.sessions.map((s) => s.sessionId)).toEqual([OV, 'plain']);
    expect(home.threads[OV].map((s) => s.sessionId)).toEqual(['b', 'a']); // oldest first
    expect(home.working).toBe(1);
    // The api folder only has the orphan, which says whose thread it is.
    const api = groups.find((g) => g.cwd === '/Users/f/ExampleCo/api')!;
    expect(api.sessions.map((s) => s.sessionId)).toEqual(['orphan']);
    expect(threadOfCaption(api.sessions[0].overseer)).toBe('Thread of Overseer · old');
    expect(threadOfCaption({ sessionId: 'x' })).toBe('Thread of an overseer');
  });

  it('keeps a thread of a nested overseer at the top level (one level of nesting)', () => {
    const rows = [
      { id: 'root', link: undefined },
      { id: 'mid', link: { sessionId: 'root' } },
      { id: 'leaf', link: { sessionId: 'mid' } },
    ];
    const n = nestUnderOverseers(rows, (r) => r.id, (r) => r.link, () => 0);
    expect(n.top.map((r) => r.id)).toEqual(['root', 'leaf']);
    expect(n.threads.get('root')?.map((r) => r.id)).toEqual(['mid']);
  });

  it('nests past sessions under their overseer, folded by default, threads in its date section', () => {
    const row = (id: string, at: number, over: Partial<HistoryRow['session']> = {}): HistoryRow => ({
      key: `h\n${id}`,
      hubId: 'h',
      hostName: 'mac',
      at,
      running: false,
      working: false,
      offline: false,
      session: { sessionId: id, title: id, named: true, cwd: '/x', createdAt: at - 100, modifiedAt: at, messageCount: 3, resumable: true, ...over },
    } as HistoryRow);
    const day = 86_400_000;
    const now = NOW;
    const rows = [
      row('ov', now - 1000, { isOverseer: true }),
      row('t2', now - 2000, { overseer: { sessionId: 'ov', thread: 't2' }, createdAt: now - 50_000 }),
      row('t1', now - 3 * day, { overseer: { sessionId: 'ov', thread: 't1' }, createdAt: now - 90_000 }),
      row('lone', now - 4 * day, { overseer: { sessionId: 'elsewhere', name: 'Overseer · far' } }),
      row('plain', now - 5 * day),
    ];
    const folded = nestHistory(rows, () => true);
    expect(folded.map((i) => [i.row.session.sessionId, i.nest])).toEqual([
      ['ov', { overseer: { threads: 2, folded: true, foldKey: 'p:h\nov' } }],
      ['lone', { caption: 'Thread of Overseer · far' }],
      ['plain', undefined],
    ]);
    const open = nestHistory(rows, () => false);
    expect(open.map((i) => [i.row.session.sessionId, i.nest?.nested])).toEqual([
      ['ov', undefined],
      ['t1', { first: true, last: false }],
      ['t2', { first: false, last: true }],
      ['lone', undefined],
      ['plain', undefined],
    ]);
    // t1 is three days older, but stays under its overseer in Today.
    const sections = sectionize(open, now);
    expect(sections.map((s) => (s.type === 'section' ? `# ${s.title}` : s.row.session.sessionId))).toEqual([
      '# Today',
      'ov',
      't1',
      't2',
      '# Previous 7 days',
      'lone',
      'plain',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Starting an overseer, adding a thread, defaults
// ---------------------------------------------------------------------------

describe('prompts and defaults', () => {
  const commands = (names: string[]): CommandInfo[] => names.map((name) => ({ name, source: 'skill' as const }));

  it('uses the overseer skill command the computer lists, else plain words', () => {
    expect(overseerCommand(commands(['skill:checkin', 'skill:overseer', 'overseer']))).toBe('skill:overseer');
    expect(overseerCommand(commands(['overseer']))).toBe('overseer');
    expect(overseerCommand(commands(['skill:checkin']))).toBeNull();
    const withSkill = overseerPrompt({ goal: '  Ship the API filters  ', defaults: DEFAULT_OVERSEER, command: 'skill:overseer' });
    expect(withSkill.split('\n')[0]).toBe('/skill:overseer Ship the API filters');
    const plain = overseerPrompt({ goal: 'Ship it', defaults: DEFAULT_OVERSEER, command: null });
    expect(plain.startsWith(`${PLAIN_OVERSEER_LEAD}Ship it\n\nDefaults for the threads you start:\n- Thread model: anthropic/claude-opus-5-5`)).toBe(true);
    expect(PLAIN_OVERSEER_LEAD).toBe('Act as overseer (use the overseer tool): ');
  });

  it('spells the defaults out in plain words', () => {
    expect(defaultsLines(DEFAULT_OVERSEER)).toEqual([
      'Thread model: anthropic/claude-opus-5-5 with thinking high ("anthropic/claude-opus-5-5:high").',
      'Thread window: auto (backend "auto": a FORCA tab or tmux window when there is one).',
      "Subagent models: pin each thread's subagentModels to the overseer skill's policy for its model.",
      'At most 4 threads at a time.',
    ]);
    const fast = defaultsLines({ threadModel: 'fast-max', window: 'headless', maxThreads: 1 });
    expect(fast[0]).toBe('Thread model: example/fast with thinking max ("example/fast:max").');
    expect(fast[1]).toBe('Thread window: headless (backend "headless", no terminal window).');
    expect(fast[3]).toBe('At most 1 thread at a time.');
    expect(defaultsLines({ ...DEFAULT_OVERSEER, threadModel: 'opus-xhigh' })[0]).toContain('"anthropic/claude-opus-5-5:xhigh"');
    expect(defaultsLines({ ...DEFAULT_OVERSEER, threadModel: 'same' }, { provider: 'anthropic', id: 'claude-sonnet-5', thinkingLevel: 'medium' })[0]).toBe(
      'Thread model: the same as yours, anthropic/claude-sonnet-5 with thinking medium.',
    );
    expect(defaultsLines({ ...DEFAULT_OVERSEER, threadModel: 'same' })[0]).toBe('Thread model: the same as yours.');
    expect(describeOverseerDefaults({ threadModel: 'fast-max', window: 'headless', maxThreads: 6 })).toBe('Fast · max · No window · up to 6');
  });

  it('names the overseer after its goal, and asks for one more thread', () => {
    expect(overseerName('Ship the API filters end to end')).toBe('Overseer · Ship the API filters end to end');
    const long = overseerName('Port the search index from the notebook into the example project with tests');
    expect(long.length).toBeLessThanOrEqual('Overseer · '.length + 40);
    expect(long.endsWith('…')).toBe(true);
    expect(overseerName('a\nb   c')).toBe('Overseer · a b c');
    expect(overseerName('   ')).toBe('Overseer');
    const add = addThreadPrompt(' Write the migration docs ', { threadModel: 'fast-max', window: 'auto', maxThreads: 3 });
    expect(add.split('\n')[0]).toBe('Start a new thread: Write the migration docs');
    expect(add).toContain('- Thread model: example/fast with thinking max');
    expect(add).toContain('- At most 3 threads at a time.');
  });

  it('parses stored defaults defensively', () => {
    expect(parseOverseerDefaults({ threadModel: 'opus-xhigh', window: 'headless', maxThreads: 6 })).toEqual({ threadModel: 'opus-xhigh', window: 'headless', maxThreads: 6 });
    expect(parseOverseerDefaults({ threadModel: 'gpt-9', maxThreads: 99 })).toEqual({ ...DEFAULT_OVERSEER, maxThreads: 12 });
    expect(parseOverseerDefaults({ window: 'headless', maxThreads: 0 })).toEqual({ ...DEFAULT_OVERSEER, window: 'headless', maxThreads: 1 });
    expect(parseOverseerDefaults({ junk: true })).toBeUndefined();
    expect(parseOverseerDefaults(null)).toBeUndefined();
    expect(parseOverseerDefaults([1])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Transcript cards, on real shapes (phi 1.4.0-exo.11 overseer sessions)
// ---------------------------------------------------------------------------

function tool(args: Record<string, unknown>, output: string | undefined, status: ToolItem['status'] = 'ok'): ToolItem {
  return { id: `t${Math.random()}`, ts: 1, kind: 'tool', toolCallId: 'c', name: 'overseer', summary: `overseer  ${String(args.action)}`, args, status, output };
}
const note = (label: string, text: string): NoteItem => ({ id: 'n', ts: 1, kind: 'note', label, text });

const REAL = {
  spawn:
    'Started thread "t-fast" (01a1a8c7-4ceb-7625-b8dc-afa83702a517) · headless pid 56444 · example/fast:max · /private/tmp/ovs-e2e-work\nSubagent policy: default example/fast:max; allow example/fast:max.\nWatching: idle on · stall 2m · heartbeat off. [overseer] updates wake you when it goes idle, errors, stalls or exits — end your turn instead of polling.\nTalk to it: overseer {action:"send", target:"t-fast", message}. Inspect: overseer {action:"read", target:"t-fast"}.',
  send: 'Sent to "t-sonnet" (auto). Its reply arrives as an [overseer] update when it goes idle.',
  close:
    'Closed "ovs-e2e2-f": session closed; FORCA tab term_38b29c3d-f8b8-4ce7-b31a-a92b2249aa14 closed. Resume it later with overseer {action:"resume", target:"01a1a919-3b7d-74fa-9d01-5404aba20587"}.',
  abort: 'Aborted the current turn of "ovs-e2e2-f". It is idle now; send it a message to continue.',
  resume: 'Resumed "t-fast" (01a1a8c7-4ceb-7625-b8dc-afa83702a517) headless (pid 57713) in /private/tmp/ovs-e2e-work. It is idle; send it a message.',
  adopt:
    'Adopted "phone-like" (01a1a8d7-07f7-76ce-b87b-157593e36976, headless, idle) · watching: idle on · stall 15m · heartbeat off. Not started by this overseer: close only stops watching it (aborting a running turn); it is never shut down.',
  model: '"t-sonnet" now runs anthropic/claude-sonnet-5:low (applies from its next turn).',
  read: 't-fast (01a1a8c7-4ceb-7625-b8dc-afa83702a517) · idle · example/fast:max · quiet 5s\n(older items exist)\n[17:56:41] tool write /tmp/x → ok',
  list: 'NAME      ID          BACKEND   STATUS  HEALTH  MODEL\nt-fast    01a1a8c7-4  headless  idle    ok      example/fast:max',
  hint: 'Reply with overseer {action:"send", target:"<thread>", message}; inspect with overseer {action:"read", target:"<thread>"}. These are thread reports, not user messages.',
};

describe('transcript: overseer tool calls', () => {
  it('turns each action into a card or a folded row', () => {
    const spawn = overseerCall(
      tool({ action: 'spawn', backend: 'headless', name: 't-fast', cwd: '/tmp/w', model: 'example/fast:max', prompt: 'Create the folder and report.' }, REAL.spawn),
    );
    expect(spawn).toMatchObject({
      action: 'spawn',
      thread: 't-fast',
      sessionId: '01a1a8c7-4ceb-7625-b8dc-afa83702a517',
      title: 'Started t-fast',
      meta: 'Fast max · No window',
      text: 'Create the folder and report.',
      folded: false,
    });
    // No backend argument: the result says where it runs.
    expect(overseerCall(tool({ action: 'spawn', name: 'api', model: 'anthropic/claude-opus-5-5:high' }, 'Started thread "api" (1a2b3c4d-5e6f) · forca tab term_3f9a · anthropic/claude-opus-5-5:high · /x'))?.meta).toBe(
      'Opus 5.5 high · FORCA tab',
    );
    expect(overseerCall(tool({ action: 'spawn', name: 'x', model: 'example/fast:max' }, undefined, 'running'))?.title).toBe('Starting x');
    const failed = overseerCall(tool({ action: 'spawn', name: 'x' }, 'Thread "x" already exists\nmore', 'error'));
    expect(failed).toMatchObject({ title: 'Could not start x', failed: true, error: 'Thread "x" already exists' });

    expect(overseerCall(tool({ action: 'send', target: 't-sonnet', message: 'Use ALPHA.' }, REAL.send))).toMatchObject({ title: 'Sent to t-sonnet', text: 'Use ALPHA.', folded: false });
    expect(overseerCall(tool({ action: 'close', target: '01a1a919' }, REAL.close))).toMatchObject({ title: 'Closed ovs-e2e2-f', thread: 'ovs-e2e2-f', folded: false });
    expect(overseerCall(tool({ action: 'abort', target: 'ovs-e2e2-f' }, REAL.abort))?.title).toBe('Stopped ovs-e2e2-f');
    expect(overseerCall(tool({ action: 'resume', target: 't-fast' }, REAL.resume))).toMatchObject({ title: 'Resumed t-fast', sessionId: '01a1a8c7-4ceb-7625-b8dc-afa83702a517' });
    expect(overseerCall(tool({ action: 'adopt', target: '01a1a8d7', name: 'phone-like' }, REAL.adopt))).toMatchObject({
      title: 'Adopted phone-like',
      sessionId: '01a1a8d7-07f7-76ce-b87b-157593e36976',
    });
    expect(overseerCall(tool({ action: 'model', target: 't-sonnet', model: 'anthropic/claude-sonnet-5', thinking: 'low' }, REAL.model))?.title).toBe('Switched t-sonnet to Sonnet 5 low');
    expect(overseerCall(tool({ action: 'read', target: 't-fast' }, REAL.read))).toMatchObject({ title: 'Read t-fast', folded: true });
    expect(overseerCall(tool({ action: 'list' }, REAL.list))).toMatchObject({ title: 'Checked the threads', folded: true, thread: undefined });
    expect(overseerCall(tool({ action: 'watch', target: 'all', watch: { stallMinutes: 5 } }, 'ok'))).toMatchObject({ folded: true });
    expect(overseerCall({ name: 'bash', args: {}, status: 'ok', output: '' })).toBeNull();
  });

  it('keeps thread cards out of the "Worked for" fold; reads fold away', () => {
    const items: TranscriptItem[] = [
      { id: 'u', ts: 1000, kind: 'user', text: '/skill:overseer go' },
      { id: 'a1', ts: 2000, kind: 'assistant', text: 'Starting.' },
      { ...tool({ action: 'spawn', name: 'api' }, REAL.spawn), id: 'sp', ts: 3000 },
      { ...tool({ action: 'read', target: 'api' }, REAL.read), id: 'rd', ts: 4000 },
      { id: 'mid', ts: 4500, kind: 'assistant', text: 'Reading.' },
      { ...tool({ action: 'send', target: 'api', message: 'hi' }, REAL.send), id: 'sd', ts: 5000 },
      { id: 'a2', ts: 60_000, kind: 'assistant', text: 'Done.' },
    ];
    const feed = buildFeed(items, { working: false, expanded: new Set() });
    const shown = feed.map((e) => (e.type === 'item' ? e.item.id : '[fold]'));
    expect(shown).toEqual(['u', 'a1', 'sp', '[fold]', 'sd', 'a2']);
  });
});

describe('transcript: overseer_event and thread reports', () => {
  it('reads batched updates (real text)', () => {
    const two = note(
      'overseer_event',
      `[overseer] 2 thread updates\n── t-fast · idle · turn finished · example/fast:max · $0.02\nDONE-LUNA\n── t-sonnet · idle · turn finished · anthropic/claude-sonnet-5:medium · $0.36\nDONE-SONNET\n${REAL.hint}`,
    );
    expect(overseerEvents(two)).toEqual([
      { thread: 't-fast', kind: 'idle', summary: 'turn finished · example/fast:max · $0.02', text: 'DONE-LUNA' },
      { thread: 't-sonnet', kind: 'idle', summary: 'turn finished · anthropic/claude-sonnet-5:medium · $0.36', text: 'DONE-SONNET' },
    ]);
    const exited = note(
      'overseer_event',
      `[overseer] 1 thread update\n── t-forca2 · exited · the session left the hub and its process is gone\nFORCA tab may still be open: forca terminal read --terminal term_6c1e --screen\nresume it with overseer {action:"resume", target:"t-forca2"}, or close it\n${REAL.hint}`,
    );
    expect(overseerEvents(exited)).toEqual([
      {
        thread: 't-forca2',
        kind: 'exited',
        summary: 'the session left the hub and its process is gone',
        text: 'FORCA tab may still be open: forca terminal read --terminal term_6c1e --screen\nresume it with overseer {action:"resume", target:"t-forca2"}, or close it',
      },
    ]);
    const stalledAndBeat = note(
      'overseer_event',
      `[overseer] 1 thread update\n── ovs-e2e-c · stalled · working with no activity for 1m (bash bash sleep 200 && echo slept)\n── heartbeat · 3 threads (1 working)\nNAME       ID           BACKEND\novs-e2e-a  01a1a8ee-c0  forca\n  last: A-DONE\n${REAL.hint}`,
    );
    const ev = overseerEvents(stalledAndBeat)!;
    expect(ev.map((e) => [e.thread, e.kind, e.summary])).toEqual([
      ['ovs-e2e-c', 'stalled', 'working with no activity for 1m (bash bash sleep 200 && echo slept)'],
      ['', 'heartbeat', '3 threads (1 working)'],
    ]);
    const beat = note('overseer_event', `[overseer] heartbeat · 3 threads (1 working)\nNAME  ID\novs-e2e-a  01a1\n${REAL.hint}`);
    expect(overseerEvents(beat)?.map((e) => [e.kind, e.summary])).toEqual([['heartbeat', '3 threads (1 working)']]);
    const error = note('overseer_event', `[overseer] 2 thread updates\n── ovs-e2e-c · error · the last turn ended in an error (example/fast:max)\nThe operation was aborted.\n── ovs-e2e-b · idle · turn finished · anthropic/claude-sonnet-5:low · $0.49\nB-UPDATED\n${REAL.hint}`);
    expect(overseerEvents(error)?.[0]).toEqual({ thread: 'ovs-e2e-c', kind: 'error', summary: 'the last turn ended in an error (example/fast:max)', text: 'The operation was aborted.' });
    expect(overseerEvents(note('agent_mail', 'x'))).toBeNull();
  });

  it('says each update in the app\'s words', () => {
    expect(eventSummary({ kind: 'idle', summary: 'turn finished · example/fast:max · $0.02' })).toBe('finished · Fast max · $0.02');
    expect(eventSummary({ kind: 'idle', summary: 'turn finished · anthropic/claude-sonnet-5:medium · $0.36' })).toBe('finished · Sonnet 5 medium · $0.36');
    // twice in a row: no regex state leaks between calls
    for (let i = 0; i < 2; i++) expect(eventSummary({ kind: 'error', summary: 'the last turn ended in an error (example/fast:max)' })).toBe('error · Fast max');
    expect(eventSummary({ kind: 'error', summary: 'the last turn ended in an error' })).toBe('error');
    expect(eventSummary({ kind: 'stalled', summary: 'working with no activity for 15m (bash sleep 200)' })).toBe('quiet for 15m');
    expect(eventSummary({ kind: 'exited', summary: 'the session left the hub and its process is gone' })).toBe('exited');
    expect(eventSummary({ kind: 'heartbeat', summary: '3 threads (1 working)' })).toBe('3 threads (1 working)');
  });

  it('reads a thread report (real agent mail) and nothing else', () => {
    const mail = note(
      'agent_mail',
      '[message from agent "ovs-e2e-b" (01a1a8ee-887908f4) in /private/tmp/ovs-e2e-live/b — another phi session, not the user]\n[thread ovs-e2e-b · question] Should the second line of result.txt be ALPHA or BETA? Continuing with ALPHA unless told otherwise.\nReply with overseer {"action":"send","target":"ovs-e2e-b","message":"..."} if a reply is needed (a report from your overseer thread; do not agent_message it).',
    );
    expect(threadReport(mail)).toEqual({ thread: 'ovs-e2e-b', kind: 'question', message: 'Should the second line of result.txt be ALPHA or BETA? Continuing with ALPHA unless told otherwise.' });
    const multi = note(
      'agent_mail',
      '[message from agent "ovs-e2e-a" (01a1a8ee) in /Users/f/ExampleCo — another phi session, not the user]\n[thread ovs-e2e-a · done] Step 2 env output:\nPHI_SUBAGENT_MODEL_ALLOW=example/fast:max\nReply with overseer {"action":"send","target":"ovs-e2e-a","message":"..."} if a reply is needed (a report from your overseer thread; do not agent_message it).',
    );
    expect(threadReport(multi)).toEqual({ thread: 'ovs-e2e-a', kind: 'done', message: 'Step 2 env output:\nPHI_SUBAGENT_MODEL_ALLOW=example/fast:max' });
    expect(threadReport(note('agent_mail', '[message from agent "x" (1) in /x — another phi session, not the user]\nhello'))).toBeNull();
    expect(threadReport(note('compaction', '[thread a · done] x'))).toBeNull();
  });
});
