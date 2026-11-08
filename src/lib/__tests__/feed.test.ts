import { buildFeed, latestReply, turnStartedAt, type FeedEntry } from '../feed';
import { argsBeyondSummary, clockTime, formatClock, formatDuration, machineSymbol, threadTitle, toolSymbol } from '../format';
import { closeOpenFence, parseMarkdown } from '../markdown';
import type { TranscriptItem } from '../protocol';

const T0 = 1_700_000_000_000;
const user = (id: string, s: number): TranscriptItem => ({ id, ts: T0 + s * 1000, kind: 'user', text: id });
const reply = (id: string, s: number, extra: Partial<Extract<TranscriptItem, { kind: 'assistant' }>> = {}): TranscriptItem => ({
  id,
  ts: T0 + s * 1000,
  kind: 'assistant',
  text: `text ${id}`,
  ...extra,
});
const tool = (id: string, s: number): TranscriptItem => ({
  id,
  ts: T0 + s * 1000,
  kind: 'tool',
  toolCallId: id,
  name: 'bash',
  summary: 'bash ls',
  status: 'ok',
});

const shape = (feed: FeedEntry[]) => feed.map((e) => (e.type === 'fold' ? `[${e.label}${e.expanded ? ' open' : ''}]` : e.key));

describe('buildFeed', () => {
  const items = [
    user('u1', 0),
    reply('a1', 2, { thinking: 'hmm' }),
    tool('t1', 3),
    reply('a2', 10),
    tool('t2', 20),
    reply('a3', 130),
    user('u2', 200),
    reply('b1', 201),
    tool('t3', 202),
  ];

  it('folds finished turns: first and final replies stay, work collapses into one row', () => {
    const feed = buildFeed(items, { working: true, expanded: new Set() });
    expect(shape(feed)).toEqual(['u1', 'a1', '[Worked for 2m 10s]', 'a3', 'u2', 'b1', 't3']);
    const a1 = feed.find((e) => e.key === 'a1');
    expect(a1?.type === 'item' && a1.hideThinking).toBe(true);
  });

  it('never folds the live turn, and folds it once the session is idle', () => {
    const idle = buildFeed(items, { working: false, expanded: new Set() });
    expect(shape(idle).slice(4)).toEqual(['u2', 'b1', '[Worked for 2s]']);
  });

  it('keeps a subagent launch (its card) out of the fold', () => {
    const launch: TranscriptItem = {
      id: 'sa',
      ts: T0 + 4000,
      kind: 'tool',
      toolCallId: 'call-sa',
      name: 'subagent',
      summary: '2 subagents: ws-a, ws-b',
      args: { tasks: [{ name: 'ws-a', task: 'x' }, { name: 'ws-b', task: 'y' }] },
      status: 'ok',
    };
    const status: TranscriptItem = { ...launch, id: 'st', toolCallId: 'call-st', args: { action: 'status' }, summary: 'subagent status' };
    const turn = [user('u1', 0), reply('a1', 2), tool('t1', 3), launch, status, reply('a2', 10), tool('t2', 20), reply('a3', 30), user('u2', 40)];
    expect(shape(buildFeed(turn, { working: true, expanded: new Set() }))).toEqual(['u1', 'a1', '[Worked for 30s]', 'sa', 'a3', 'u2']);
    expect(shape(buildFeed([user('u1', 0), launch, user('u2', 9)], { working: true, expanded: new Set() }))).toEqual(['u1', 'sa', 'u2']);
  });

  it('expands a folded turn in place', () => {
    const feed = buildFeed(items, { working: true, expanded: new Set(['u1']) });
    expect(shape(feed)).toEqual(['u1', 'a1', '[Worked for 2m 10s open]', 't1', 'a2', 't2', 'a3', 'u2', 'b1', 't3']);
    const a1 = feed.find((e) => e.key === 'a1');
    expect(a1?.type === 'item' && a1.hideThinking).toBe(false);
  });

  it('labels stopped turns and leaves failed turns open', () => {
    const stopped = [user('u', 0), tool('t', 5), reply('a', 40, { error: 'aborted', text: '' })];
    expect(shape(buildFeed(stopped, { working: false, expanded: new Set() }))).toEqual(['u', '[You stopped after 40s]', 'a']);
    const failed = [user('u', 0), tool('t', 5), reply('a', 6, { error: 'rate limited' })];
    expect(shape(buildFeed(failed, { working: false, expanded: new Set() }))).toEqual(['u', 't', 'a']);
  });

  it('does not fold a turn with nothing to hide, or one still streaming', () => {
    expect(shape(buildFeed([user('u', 0), reply('a', 1)], { working: false, expanded: new Set() }))).toEqual(['u', 'a']);
    const streaming = [user('u', 0), tool('t', 1), reply('a', 2, { streaming: true })];
    expect(shape(buildFeed(streaming, { working: false, expanded: new Set() }))).toEqual(['u', 't', 'a']);
  });

  it('never folds a reply that ended a run, even when a later message got its own reply', () => {
    // Session 01a19e0c: work, a mid-run compaction, the answer, then subagent results arrived
    // and the agent replied to them. Both replies answer something; neither may fold.
    const note = (id: string, s: number, label: string): TranscriptItem => ({ id, ts: T0 + s * 1000, kind: 'note', label, text: label });
    const turn = [
      user('u1', 0),
      tool('t0', 1),
      reply('a1', 5, { thinking: 'hmm' }),
      tool('t1', 6),
      reply('a2', 10),
      tool('t2', 11),
      note('n-compaction', 20, 'compaction'),
      reply('a3', 21),
      tool('t3', 22),
      note('n-wake', 30, 'optmem-wake'),
      reply('answer', 40, { thinking: 'so' }),
      note('n-results', 41, 'subagent-results'),
      reply('ack', 45),
    ];
    const feed = buildFeed(turn, { working: false, expanded: new Set() });
    expect(shape(feed)).toEqual(['u1', '[Worked for 45s]', 'a1', 'n-compaction', 'n-wake', 'answer', 'n-results', 'ack']);
    const answer = feed.find((e) => e.key === 'answer');
    expect(answer?.type === 'item' && answer.hideThinking).toBe(true);
    // Expanded, every row is back in place.
    expect(shape(buildFeed(turn, { working: false, expanded: new Set(['u1']) }))).toEqual([
      'u1',
      '[Worked for 45s open]',
      ...turn.slice(1).map((item) => item.id),
    ]);
    // A reply with tool calls after it is narration: it folds unless it is the first or the last.
    const narrated = [user('u', 0), reply('n1', 1), tool('t1', 2), reply('n2', 3), tool('t2', 4), reply('done', 5)];
    expect(shape(buildFeed(narrated, { working: false, expanded: new Set() }))).toEqual(['u', 'n1', '[Worked for 5s]', 'done']);
  });

  it('handles history that starts mid-turn', () => {
    const feed = buildFeed([tool('t0', 0), reply('a0', 5), user('u', 10)], { working: false, expanded: new Set() });
    expect(shape(feed)).toEqual(['[Worked for 5s]', 'a0', 'u']);
  });

  it('finds the turn start and the latest reply', () => {
    expect(turnStartedAt(items)).toBe(T0 + 200_000);
    expect(turnStartedAt([reply('a', 1)])).toBeNull();
    expect(latestReply([...items, reply('s', 300, { streaming: true })])?.id).toBe('b1');
  });
});

describe('format helpers', () => {
  it('formats durations and clocks', () => {
    expect(formatDuration(12_400)).toBe('12s');
    expect(formatDuration(245_000)).toBe('4m 05s');
    expect(formatDuration(3_840_000)).toBe('1h 04m');
    expect(formatDuration(-5)).toBe('0s');
    expect(formatClock(7_900)).toBe('0:07');
    expect(formatClock(102_000)).toBe('1:42');
    expect(clockTime(0)).toBe('');
    expect(clockTime(T0)).toMatch(/\d/);
  });

  it('guesses machine symbols and thread titles', () => {
    expect(machineSymbol("Alex's MacBook Pro")).toBe('laptopcomputer');
    expect(machineSymbol('devbox')).toBe('server.rack');
    expect(machineSymbol('Mac mini')).toBe('desktopcomputer');
    expect(threadTitle('phi — fix the build')).toBe('fix the build');
    expect(threadTitle('', '\n first line\nsecond')).toBe('first line');
    expect(threadTitle('')).toBe('New session');
  });

  it('maps tools to symbols and hides args the summary already shows', () => {
    expect(toolSymbol('bash')).toBe('terminal');
    expect(toolSymbol('read')).toBe('eye');
    expect(toolSymbol('edit')).toBe('square.and.pencil');
    expect(toolSymbol('grep')).toBe('magnifyingglass');
    expect(toolSymbol('web_fetch')).toBe('globe');
    expect(toolSymbol('subagent')).toBe('sparkles');
    expect(toolSymbol('mystery')).toBe('wrench');
    expect(argsBeyondSummary({ command: 'npm test' }, 'bash npm test')).toBe('');
    expect(argsBeyondSummary({ path: 'a.ts', limit: 20 }, 'read a.ts')).toBe('limit: 20');
    expect(
      argsBeyondSummary({ path: 'a.ts', edits: [{ oldText: 'const a = 1;\n', newText: 'const a = 2;\nconst b = 3;\n' }] }, 'edit  a.ts'),
    ).toBe('- const a = 1;\n+ const a = 2;\n+ const b = 3;');
    expect(argsBeyondSummary({ command: 'git diff', cwd: '/tmp', env: { A: '1' } }, 'bash git diff')).toBe(
      'cwd: /tmp\nenv: {\n  "A": "1"\n}',
    );
    expect(argsBeyondSummary(undefined, 'x')).toBe('');
  });
});

describe('streaming markdown', () => {
  it('closes an unfinished code fence so it renders as code', () => {
    expect(closeOpenFence('Here:\n```ts\nconst a')).toBe('Here:\n```ts\nconst a\n```');
    expect(closeOpenFence('```\na\n```\ndone')).toBe('```\na\n```\ndone');
    expect(closeOpenFence('~~~~\nx\n```\n')).toBe('~~~~\nx\n```\n~~~~');
    const blocks = parseMarkdown(closeOpenFence('Intro\n\n```sh\nnpm te'));
    expect(blocks[1]).toEqual({ type: 'code', lang: 'sh', text: 'npm te' });
  });

  it('keeps image alt text as an image node', () => {
    expect(parseMarkdown('![chart](https://x/c.png)')).toEqual([
      { type: 'paragraph', children: [{ type: 'image', alt: 'chart', href: 'https://x/c.png' }] },
    ]);
  });
});
