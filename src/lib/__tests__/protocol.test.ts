import { parseCommandInfo, parseServerFrame, parseSessionSummary, parseTranscriptItem } from '../protocol';

describe('parseServerFrame', () => {
  it('ignores non-JSON, non-objects, missing t and unknown types', () => {
    expect(parseServerFrame('{')).toBeNull();
    expect(parseServerFrame('[1]')).toBeNull();
    expect(parseServerFrame('{"x":1}')).toBeNull();
    expect(parseServerFrame('{"t":"brand.new"}')).toBeNull();
    expect(parseServerFrame(null)).toBeNull();
  });

  it('parses welcome and drops unknown fields', () => {
    expect(
      parseServerFrame({
        t: 'welcome',
        host: { name: 'MY-MAC', hubId: 'h', hubVersion: '1.2.3', protocol: 1, extra: true },
        deviceId: 'd',
        future: 'x',
      }),
    ).toEqual({ t: 'welcome', host: { name: 'MY-MAC', hubId: 'h', hubVersion: '1.2.3', protocol: 1, features: [] }, deviceId: 'd' });
  });

  it('parses ack with and without error', () => {
    expect(parseServerFrame({ t: 'ack', re: '1', ok: true, sessionId: 's' })).toEqual({
      t: 'ack',
      re: '1',
      ok: true,
      sessionId: 's',
    });
    expect(parseServerFrame({ t: 'ack', re: '1', ok: false })).toEqual({
      t: 'ack',
      re: '1',
      ok: false,
      error: { code: 'internal', message: 'Request failed' },
    });
    expect(parseServerFrame({ t: 'ack', ok: true })).toBeNull();
  });

  it('keeps valid sessions and skips malformed ones', () => {
    const f = parseServerFrame({
      t: 'sessions',
      re: '2',
      sessions: [
        { sessionId: 'a', name: 'A', cwd: '/x', host: 'h', pid: 1, kind: 'headless', status: 'working', startedAt: 5, lastActivityAt: 9 },
        { sessionId: 'b', status: 'sleeping' },
        'junk',
      ],
    });
    expect(f && f.t === 'sessions' && f.sessions.map((s) => s.sessionId)).toEqual(['a']);
  });

  it('parses snapshot items, defaulting state when missing', () => {
    const f = parseServerFrame({
      t: 'session.snapshot',
      re: '3',
      sessionId: 's',
      items: [
        { id: '1', ts: 1, kind: 'user', text: 'hi', images: 2 },
        { id: '2', ts: 2, kind: 'mystery' },
        { id: '3', ts: 3, kind: 'tool', toolCallId: 'c', name: 'read', summary: 'read  a.ts', status: 'ok', args: { path: 'a.ts' } },
      ],
      hasMore: true,
    });
    expect(f).toEqual({
      t: 'session.snapshot',
      re: '3',
      sessionId: 's',
      items: [
        { id: '1', ts: 1, kind: 'user', text: 'hi', images: 2 },
        { id: '3', ts: 3, kind: 'tool', toolCallId: 'c', name: 'read', summary: 'read  a.ts', status: 'ok', args: { path: 'a.ts' } },
      ],
      hasMore: true,
      state: { status: 'idle' },
    });
  });

  it('parses live events and drops invalid ones', () => {
    expect(parseServerFrame({ t: 'session.event', sessionId: 's', event: { type: 'reset' } })).toEqual({
      t: 'session.event',
      sessionId: 's',
      event: { type: 'reset' },
    });
    expect(
      parseServerFrame({ t: 'session.event', sessionId: 's', event: { type: 'state', state: { status: 'working', activity: { tool: 'bash' } } } }),
    ).toEqual({ t: 'session.event', sessionId: 's', event: { type: 'state', state: { status: 'working', activity: { tool: 'bash' } } } });
    expect(parseServerFrame({ t: 'session.event', sessionId: 's', event: { type: 'item.upsert', item: {} } })).toBeNull();
    expect(parseServerFrame({ t: 'session.event', sessionId: 's', event: { type: 'weird' } })).toBeNull();
  });

  it('parses models and cwds', () => {
    expect(
      parseServerFrame({
        t: 'models',
        re: '4',
        models: [{ provider: 'anthropic', id: 'opus', name: 'Opus', reasoning: true }, { provider: 1 }],
        current: { provider: 'anthropic', id: 'opus' },
        thinkingLevel: 'high',
        thinkingLevels: ['off', 'low', 'high', 3],
      }),
    ).toEqual({
      t: 'models',
      re: '4',
      models: [{ provider: 'anthropic', id: 'opus', name: 'Opus', reasoning: true }],
      current: { provider: 'anthropic', id: 'opus' },
      thinkingLevel: 'high',
      thinkingLevels: ['off', 'low', 'high'],
    });
    expect(parseServerFrame({ t: 'cwds', re: '5', cwds: ['/a', 2, '/b'] })).toEqual({ t: 'cwds', re: '5', cwds: ['/a', '/b'] });
  });
});

describe('item and summary parsing', () => {
  it('fills a missing session name from the cwd basename', () => {
    expect(parseSessionSummary({ sessionId: 'x', cwd: '/Users/me/proj/', status: 'idle' })?.name).toBe('proj');
  });

  it('requires a tool status and defaults the summary to the name', () => {
    expect(parseTranscriptItem({ id: '1', kind: 'tool', name: 'bash' })).toBeNull();
    expect(parseTranscriptItem({ id: '1', kind: 'tool', name: 'bash', status: 'running' })).toEqual({
      id: '1',
      ts: 0,
      kind: 'tool',
      toolCallId: '1',
      name: 'bash',
      summary: 'bash',
      status: 'running',
    });
  });

  it('only keeps streaming when true', () => {
    expect(parseTranscriptItem({ id: 'a', kind: 'assistant', text: 'x', streaming: false })).toEqual({
      id: 'a',
      ts: 0,
      kind: 'assistant',
      text: 'x',
    });
  });
});

describe('slash commands (v1 addition)', () => {
  it('parses a commands reply, skipping malformed and duplicate entries', () => {
    expect(
      parseServerFrame({
        t: 'commands',
        re: 'r1',
        sessionId: 's1',
        commands: [
          { name: 'new', source: 'builtin', description: 'Start a new session' },
          { name: '/skill:use-subs', source: 'skill', description: '  Swarm  ', argumentHint: '' },
          { name: 'odd', source: 'future-kind' },
          { name: 'has space', source: 'prompt' },
          { name: '', source: 'prompt' },
          { source: 'prompt' },
          { name: 'new', source: 'prompt' },
          'junk',
        ],
      }),
    ).toEqual({
      t: 'commands',
      re: 'r1',
      sessionId: 's1',
      commands: [
        { name: 'new', source: 'builtin', description: 'Start a new session' },
        { name: 'skill:use-subs', source: 'skill', description: 'Swarm' },
        { name: 'odd', source: 'extension' },
      ],
    });
    expect(parseServerFrame({ t: 'commands', sessionId: 's1', commands: [] })).toBeNull(); // no re
    expect(parseServerFrame({ t: 'commands', re: 'r', commands: 'x' })).toEqual({ t: 'commands', re: 'r', sessionId: '', commands: [] });
    expect(parseCommandInfo({ name: 'compact', source: 'builtin', argumentHint: '[instructions]' })).toEqual({
      name: 'compact',
      source: 'builtin',
      argumentHint: '[instructions]',
    });
  });

  it('keeps commandsVersion (opaque string, numbers tolerated)', () => {
    const base = { sessionId: 's', status: 'idle', cwd: '/x' };
    expect(parseSessionSummary({ ...base, commandsVersion: 'd-1pujtj9' })?.commandsVersion).toBe('d-1pujtj9');
    expect(parseSessionSummary({ ...base, commandsVersion: 3 })?.commandsVersion).toBe(3);
    expect(parseSessionSummary({ ...base, commandsVersion: { x: 1 } })).not.toHaveProperty('commandsVersion');
  });

  it('parses replacedBy on reset and session.remove', () => {
    expect(parseServerFrame({ t: 'session.event', sessionId: 'a', event: { type: 'reset', replacedBy: 'b' } })).toEqual({
      t: 'session.event',
      sessionId: 'a',
      event: { type: 'reset', replacedBy: 'b' },
    });
    expect(parseServerFrame({ t: 'session.event', sessionId: 'a', event: { type: 'reset', replacedBy: 7 } })).toEqual({
      t: 'session.event',
      sessionId: 'a',
      event: { type: 'reset' },
    });
    expect(parseServerFrame({ t: 'session.remove', sessionId: 'a', replacedBy: 'b' })).toEqual({ t: 'session.remove', sessionId: 'a', replacedBy: 'b' });
    expect(parseServerFrame({ t: 'session.remove', sessionId: 'a', replacedBy: 'a' })).toEqual({ t: 'session.remove', sessionId: 'a' });
  });
});

describe('subagents (v1 addition)', () => {
  const base = { sessionId: 'p~sa~r1', status: 'working', cwd: '/x', name: 'ws-a' };
  const run = { runId: 'r1', toolCallId: 'call-1', index: 2, name: 'ws-a', agent: 'scout', task: 'Map it', status: 'running', startedAt: 5, background: true };

  it('parses a subagent session with its parent and run', () => {
    const s = parseSessionSummary({ ...base, kind: 'subagent', parentSessionId: 'p', subagent: run, subagents: { running: 1, total: 1 } });
    expect(s).toMatchObject({ kind: 'subagent', parentSessionId: 'p', subagent: run });
    // counts only belong on parents
    expect(s).not.toHaveProperty('subagents');
  });

  it('drops a subagent session it cannot place', () => {
    expect(parseSessionSummary({ ...base, kind: 'subagent', subagent: run })).toBeNull();
    expect(parseSessionSummary({ ...base, kind: 'subagent', parentSessionId: 'p' })).toBeNull();
    expect(parseSessionSummary({ ...base, kind: 'subagent', parentSessionId: 'p', subagent: { ...run, status: 'paused' } })).toBeNull();
    // an unknown kind is still a thread
    expect(parseSessionSummary({ ...base, kind: 'robot' })?.kind).toBe('interactive');
  });

  it('parses parent counts and tmux, ignoring junk', () => {
    const p = parseSessionSummary({ ...base, kind: 'interactive', subagents: { running: 2, total: 3 }, tmux: { session: 'phi-remote', window: '1' } });
    expect(p).toMatchObject({ subagents: { running: 2, total: 3 }, tmux: { session: 'phi-remote', window: '1' } });
    const q = parseSessionSummary({ ...base, subagents: { running: 'x' }, tmux: { window: '1' } });
    expect(q).not.toHaveProperty('subagents');
    expect(q).not.toHaveProperty('tmux');
  });
});
