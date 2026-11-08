import { sessionHref } from '../format';
import type { ToolItem } from '../protocol';
import {
  childrenOf,
  countRows,
  countsByParent,
  countsLabel,
  looksLikeSubagentId,
  parentCounts,
  parseSubagentCounts,
  parseSubagentInfo,
  parseTmux,
  shortModelRef,
  parentMessageText,
  steerErrorText,
  steerPlaceholder,
  subagentElapsed,
  subagentFooter,
  subagentGroups,
  subagentLaunch,
  subagentRows,
  subagentStats,
  subagentsMeta,
  subagentSubtitle,
  subagentTitle,
  tmuxAttachCommand,
  type SubagentChild,
  type SubagentInfo,
} from '../subagents';

function tool(over: Partial<ToolItem> = {}): ToolItem {
  return {
    id: 't1',
    ts: 1000,
    kind: 'tool',
    toolCallId: 'call-1',
    name: 'subagent',
    summary: '3 subagents: ws-a, ws-b, ws-c',
    args: {
      tasks: [
        { name: 'ws-a', task: 'Map the registry', agent: 'scout' },
        { name: 'ws-b', task: 'Write throttle tests', model: 'anthropic/claude-haiku-4-5:low' },
        { task: 'Port the pairing flow' },
      ],
    },
    status: 'ok',
    ...over,
  };
}

function child(over: Partial<SubagentChild> & { info?: Partial<SubagentInfo> } = {}): SubagentChild {
  const { info, ...rest } = over;
  return {
    sessionId: 'p~sa~r1',
    name: 'ws-a',
    status: 'working',
    parentSessionId: 'p',
    subagent: { runId: 'r1', toolCallId: 'call-1', index: 0, name: 'ws-a', task: 'Map the registry', status: 'running', startedAt: 2000, ...info },
    ...rest,
  };
}

describe('parsing', () => {
  it('validates SessionSummary.subagent', () => {
    expect(parseSubagentInfo({ runId: 'r', task: 't', status: 'done', startedAt: 5, endedAt: 9, turns: 2.7, toolCalls: 4, index: 1, background: true, junk: 1 })).toEqual({
      runId: 'r',
      task: 't',
      status: 'done',
      startedAt: 5,
      endedAt: 9,
      turns: 2,
      toolCalls: 4,
      index: 1,
      background: true,
    });
    expect(parseSubagentInfo({ runId: 'r', task: 't', status: 'paused' })).toBeNull();
    expect(parseSubagentInfo({ task: 't', status: 'done' })).toBeNull();
    expect(parseSubagentInfo({ runId: 'r', status: 'killed', index: -1 })).toEqual({ runId: 'r', task: '', status: 'killed', startedAt: 0 });
  });

  it('validates parent counts and tmux', () => {
    expect(parseSubagentCounts({ running: 2, total: 3 })).toEqual({ running: 2, total: 3 });
    expect(parseSubagentCounts({ running: 5, total: 3 })).toEqual({ running: 3, total: 3 });
    expect(parseSubagentCounts({ total: 3 })).toBeUndefined();
    expect(parseTmux({ session: 'phi-remote', window: '2' })).toEqual({ session: 'phi-remote', window: '2' });
    expect(parseTmux({ session: 'main', window: 3 })).toEqual({ session: 'main', window: '3' });
    expect(parseTmux({ window: '1' })).toBeUndefined();
  });

  it('shortens phi model refs', () => {
    expect(shortModelRef('anthropic/claude-sonnet-5:medium')).toBe('claude-sonnet-5');
    expect(shortModelRef('example/fast')).toBe('fast');
    expect(shortModelRef(undefined)).toBeUndefined();
  });
});

describe('subagentLaunch', () => {
  it('reads tasks, chain and single-task args, with phi default names', () => {
    expect(subagentLaunch(tool())!.tasks).toEqual([
      { index: 0, name: 'ws-a', agent: 'scout', task: 'Map the registry' },
      { index: 1, name: 'ws-b', model: 'claude-haiku-4-5', task: 'Write throttle tests' },
      { index: 2, name: 'Port the pairing flow', task: 'Port the pairing flow' },
    ]);
    expect(subagentLaunch(tool({ args: { chain: [{ agent: 'planner', task: 'plan' }] } }))!.tasks).toEqual([
      { index: 0, name: 'planner', agent: 'planner', task: 'plan' },
    ]);
    expect(subagentLaunch(tool({ args: { task: 'one thing', name: 'solo', background: true } }))).toEqual({
      tasks: [{ index: 0, name: 'solo', task: 'one thing' }],
      background: true,
    });
  });

  it('falls back to the summary when the args are missing or truncated', () => {
    expect(subagentLaunch(tool({ args: '{"tasks":[{"name":"ws-a","task":"Map th' }))!.tasks.map((t) => t.name)).toEqual(['ws-a', 'ws-b', 'ws-c']);
    expect(subagentLaunch(tool({ args: undefined, summary: '2 subagents (chain): plan → build' }))!.tasks.map((t) => t.name)).toEqual(['plan', 'build']);
    expect(subagentLaunch(tool({ args: undefined, summary: '1 subagent: x' }))!.tasks.map((t) => t.name)).toEqual(['x']);
    expect(subagentLaunch(tool({ args: undefined, summary: 'subagent' }))).toBeNull();
    expect(subagentLaunch(tool({ args: undefined, summary: 'subagent  message ws-a  note: do x' }))).toBeNull();
    expect(subagentLaunch(tool({ args: undefined, summary: 'subagent  kill ws-a' }))).toBeNull();
  });

  it('numbers repeated names like phi does', () => {
    const t = tool({ args: { tasks: [{ agent: 'scout', task: 'a' }, { agent: 'scout', task: 'b' }, { name: 'scout', task: 'c' }] } });
    expect(subagentLaunch(t)!.tasks.map((x) => x.name)).toEqual(['scout', 'scout #2', 'scout #3']);
  });

  it('ignores other tools and the status / kill actions', () => {
    expect(subagentLaunch(tool({ name: 'bash' }))).toBeNull();
    expect(subagentLaunch(tool({ args: { action: 'status' } }))).toBeNull();
    expect(subagentLaunch(tool({ args: { action: 'kill', target: 'ws-a' } }))).toBeNull();
    expect(subagentLaunch(tool({ args: { action: 'message', target: 'ws-a', message: 'hi' }, summary: 'subagent  message ws-a  hi' }))).toBeNull();
    expect(subagentLaunch(tool({ args: '{"action":"run","task":"x"}' }))!.tasks).toHaveLength(1);
  });
});

describe('subagentRows', () => {
  it('matches child sessions by toolCallId + index', () => {
    const a = child();
    const b = child({
      sessionId: 'p~sa~r2',
      name: 'ws-b',
      status: 'idle',
      model: { provider: 'anthropic', id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
      info: { runId: 'r2', index: 1, name: 'ws-b', task: 'Write throttle tests', status: 'failed', endedAt: 9000, toolCalls: 3 },
    });
    const other = child({ sessionId: 'p~sa~r9', info: { runId: 'r9', toolCallId: 'call-0', index: 0 } });
    const rows = subagentRows(tool(), [b, a, other])!;
    expect(rows.map((r) => [r.name, r.status, r.sessionId ?? null, r.model ?? null, r.agent ?? null])).toEqual([
      ['ws-a', 'running', 'p~sa~r1', null, 'scout'],
      ['ws-b', 'failed', 'p~sa~r2', 'Claude Haiku 4.5', null],
      ['Port the pairing flow', 'unknown', null, null, null],
    ]);
    expect(rows[1]).toMatchObject({ endedAt: 9000, toolCalls: 3, working: false });
    expect(rows[0].working).toBe(true);
  });

  it('works from the args alone (before children arrive, or older hubs)', () => {
    expect(subagentRows(tool({ status: 'running' }), [])!.map((r) => r.status)).toEqual(['running', 'running', 'running']);
    expect(subagentRows(tool({ status: 'error' }), [])!.map((r) => r.status)).toEqual(['failed', 'failed', 'failed']);
    // A blocking run that returned ok is done; a background launch only started them.
    expect(subagentRows(tool({ args: { task: 'x', background: false } }), [])![0].status).toBe('done');
    expect(subagentRows(tool({ args: { task: 'x' }, output: 'Launched 1 subagent in the background (single mode): task-1.' }), [])![0].status).toBe('unknown');
    expect(subagentRows(tool({ name: 'read' }), [])).toBeNull();
  });

  it('falls back to names, and appends children the args do not list', () => {
    const named = child({ name: 'ws-b', info: { index: undefined, name: 'ws-b' }, sessionId: 'p~sa~x' });
    const extra = child({ sessionId: 'p~sa~y', name: 'ws-z', info: { runId: 'y', index: 7, name: 'ws-z', task: 'extra' } });
    const rows = subagentRows(tool(), [named, extra])!;
    expect(rows.map((r) => [r.name, r.sessionId ?? null])).toEqual([
      ['ws-a', null],
      ['ws-b', 'p~sa~x'],
      ['Port the pairing flow', null],
      ['ws-z', 'p~sa~y'],
    ]);
  });

  it('shows activity only while running', () => {
    const running = child({ activity: { tool: 'bash', summary: 'npm test' } });
    const done = child({ activity: { tool: 'bash' }, info: { status: 'done' } });
    expect(subagentRows(tool(), [running])![0].activity).toEqual({ tool: 'bash', summary: 'npm test' });
    expect(subagentRows(tool(), [done])![0].activity).toBeUndefined();
  });

  it('lists every child of a parent, grouped by launch, newest first', () => {
    const first = tool({ id: 'x1', toolCallId: 'call-0', ts: 10, args: { task: 'old', name: 'old' } });
    const second = tool({ id: 'x2', ts: 20 });
    const orphan = child({ sessionId: 'p~sa~o', name: 'lost', info: { runId: 'o', toolCallId: 'call-gone', index: 0, name: 'lost' } });
    const groups = subagentGroups([first, second], [child(), orphan]);
    expect(groups.map((g) => [g.key, g.rows.map((r) => r.name)])).toEqual([
      ['call-1', ['ws-a', 'ws-b', 'Port the pairing flow']],
      ['call-0', ['old']],
      ['other', ['lost']],
    ]);
  });

  it('finds a parent’s children in the host map', () => {
    const sessions = {
      p: { sessionId: 'p', name: 'parent', status: 'idle' as const },
      a: child({ sessionId: 'a', info: { startedAt: 30 } }),
      b: child({ sessionId: 'b', info: { startedAt: 10 } }),
      c: child({ sessionId: 'c', parentSessionId: 'q' }),
    };
    expect(childrenOf(sessions, 'p').map((s) => s.sessionId)).toEqual(['b', 'a']);
    expect(childrenOf(undefined, 'p')).toEqual([]);
  });
});

describe('labels', () => {
  it('counts rows for the card header', () => {
    const c = countRows([{ status: 'running' }, { status: 'running' }, { status: 'done' }, { status: 'failed' }, { status: 'killed' }, { status: 'unknown' }]);
    expect(c).toEqual({ running: 2, done: 1, failed: 1, killed: 1, unknown: 1, total: 6 });
    expect(countsLabel(c)).toBe('2 running · 1 done · 1 failed · 1 stopped');
    expect(countsLabel(countRows([{ status: 'unknown' }]))).toBe('');
  });

  it('labels a parent on the home list', () => {
    expect(subagentsMeta({ running: 2, total: 4 })).toEqual({ label: '2 subagents running', running: true });
    expect(subagentsMeta({ running: 1, total: 1 })).toEqual({ label: '1 subagent running', running: true });
    expect(subagentsMeta({ running: 0, total: 4 })).toEqual({ label: '4 subagents', running: false });
    expect(subagentsMeta({ running: 0, total: 0 })).toBeNull();
    expect(subagentsMeta(undefined)).toBeNull();
  });

  it('counts every parent on a host', () => {
    const sessions = {
      p: { sessionId: 'p', name: 'parent', status: 'idle' as const },
      q: { sessionId: 'q', name: 'reported', status: 'idle' as const, subagents: { running: 0, total: 4 } },
      r: { sessionId: 'r', name: 'none', status: 'idle' as const },
      a: child({ sessionId: 'a' }),
      b: child({ sessionId: 'b', info: { status: 'done' } }),
    };
    expect([...countsByParent(sessions)]).toEqual([
      ['p', { running: 1, total: 2 }],
      ['q', { running: 0, total: 4 }],
    ]);
    expect(countsByParent(undefined).size).toBe(0);
  });

  it('prefers the hub counts, else counts children', () => {
    expect(parentCounts({ running: 1, total: 2 }, [])).toEqual({ running: 1, total: 2 });
    expect(parentCounts({ running: 0, total: 0 }, [child()])).toBeUndefined();
    expect(parentCounts(undefined, [child(), child({ info: { status: 'done' } })])).toEqual({ running: 1, total: 2 });
    expect(parentCounts(undefined, [])).toBeUndefined();
  });

  it('formats elapsed time and stats', () => {
    expect(subagentElapsed({ startedAt: 1000, status: 'running' }, 65_000)).toBe('1m 04s');
    expect(subagentElapsed({ startedAt: 1000, endedAt: 13_000, status: 'done' }, 99_999)).toBe('12s');
    expect(subagentElapsed({ startedAt: 1000, status: 'done' }, 99_999)).toBeNull();
    expect(subagentElapsed({ status: 'running' }, 99_999)).toBeNull();
    expect(subagentStats({ turns: 6, toolCalls: 14 })).toBe('6 turns · 14 tool calls');
    expect(subagentStats({ turns: 1, toolCalls: 1 })).toBe('1 turn · 1 tool call');
    expect(subagentStats({})).toBe('');
  });

  it('writes the finished footer', () => {
    expect(subagentFooter({ status: "done", startedAt: 1000, endedAt: 193_000, toolCalls: 14 })).toEqual({
      title: 'Finished',
      text: 'Finished · 3m 12s · 14 tool calls',
      tone: 'secondary',
    });
    expect(subagentFooter({ status: 'failed', startedAt: 1, endedAt: 40_001 }).text).toBe('Failed · 40s');
    expect(subagentFooter({ status: 'killed', startedAt: 1, toolCalls: 1 }).text).toBe('Stopped · 1 tool call');
  });

  it('names subagent threads', () => {
    expect(subagentTitle(child())).toBe('ws-a');
    expect(subagentTitle(child({ name: 'scout #2', info: { name: undefined } }))).toBe('scout #2');
    expect(subagentTitle({ name: 'session name' })).toBe('session name');
    expect(subagentSubtitle('Ship the hub', 'Claude Sonnet 5')).toBe('Subagent of Ship the hub · Claude Sonnet 5');
    expect(subagentSubtitle(null, '')).toBe('Subagent');
    expect(steerPlaceholder('ws-a')).toBe('Steer ws-a…');
  });

  it('routes to subagent threads with the opaque id intact', () => {
    expect(sessionHref('hub_1', 'abc~sa~0193f')).toBe('/session/hub_1/abc~sa~0193f');
    expect(decodeURIComponent(sessionHref('hub 1', 'a b~sa~c').split('/')[3])).toBe('a b~sa~c');
    expect(looksLikeSubagentId('abc~sa~0193f')).toBe(true);
    expect(looksLikeSubagentId('5b0c4f7e-1d2a')).toBe(false);
  });

  it('reads parent messages and refused steers', () => {
    expect(parentMessageText('[message from your parent agent] Also update the docs.')).toBe('Also update the docs.');
    expect(parentMessageText('plain prompt')).toBeNull();
    expect(steerErrorText('ws-c', 'not accepting messages yet; try again')).toBe('ws-c is not accepting messages yet. Try again in a moment.');
    expect(steerErrorText('ws-c', 'subagent finished')).toBe('ws-c has finished.');
    expect(steerErrorText('ws-c', 'boom')).toBe('boom');
  });

  it('builds tmux attach commands', () => {
    expect(tmuxAttachCommand({ session: 'phi-remote', window: '2' })).toBe('tmux attach -t phi-remote:2');
    expect(tmuxAttachCommand({ session: 'my work' })).toBe("tmux attach -t 'my work'");
  });
});
