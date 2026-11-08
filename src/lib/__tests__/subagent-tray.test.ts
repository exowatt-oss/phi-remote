import type { ToolItem, TranscriptItem } from '../protocol';
import {
  ackTray,
  ackTrayFailures,
  advanceTray,
  EMPTY_TRAY,
  FINISH_LINGER_MS,
  threadSubagentRows,
  trayView,
  type TrayMemory,
  type TrayRow,
} from '../subagent-tray';
import type { SubagentChild, SubagentInfo, SubagentRunStatus } from '../subagents';

function launch(toolCallId: string, names: string[], over: Partial<ToolItem> = {}): ToolItem {
  return {
    id: `t-${toolCallId}`,
    ts: 1000,
    kind: 'tool',
    toolCallId,
    name: 'subagent',
    summary: `${names.length} subagents: ${names.join(', ')}`,
    args: { tasks: names.map((name) => ({ name, task: `do ${name}` })), background: true },
    status: 'ok',
    ...over,
  };
}

function child(toolCallId: string, index: number, name: string, status: SubagentRunStatus, info: Partial<SubagentInfo> = {}): SubagentChild {
  return {
    sessionId: `p~sa~${name}`,
    name,
    status: status === 'running' ? 'working' : 'idle',
    parentSessionId: 'p',
    subagent: { runId: name, toolCallId, index, task: `do ${name}`, status, startedAt: 2000, ...info },
  };
}

const user = (id: string): TranscriptItem => ({ id, ts: 900, kind: 'user', text: 'go' });

/** Runs the tray as the thread screen does: advance, then view. */
function step(memory: TrayMemory, rows: TrayRow[], now: number, cap = 3) {
  const next = advanceTray(memory, rows, now);
  return { memory: next, view: trayView(next, rows, cap) };
}

describe('threadSubagentRows', () => {
  it('lists every launch in order, matched to children, with loose children first', () => {
    const items = [user('u1'), launch('c1', ['a', 'b']), user('u2'), launch('c2', ['c'])];
    const kids = [child('c1', 0, 'a', 'done'), child('c1', 1, 'b', 'running'), child('c2', 0, 'c', 'running'), child('gone', 0, 'old', 'running')];
    const rows = threadSubagentRows(items, kids, true);
    expect(rows.map((r) => [r.name, r.status, r.launch, r.id])).toEqual([
      ['old', 'running', 'child:p~sa~old', 'p~sa~old'],
      ['a', 'done', 'c1', 'p~sa~a'],
      ['b', 'running', 'c1', 'p~sa~b'],
      ['c', 'running', 'c2', 'p~sa~c'],
    ]);
  });

  it('keeps args-only rows (queued, older hubs) and drops them to unknown when the thread stopped', () => {
    const items = [launch('c1', ['a', 'b'], { status: 'running' })];
    expect(threadSubagentRows(items, [], true).map((r) => [r.name, r.status, r.id])).toEqual([
      ['a', 'running', 'task:c1:0'],
      ['b', 'running', 'task:c1:1'],
    ]);
    expect(threadSubagentRows(items, [], false).map((r) => r.status)).toEqual(['unknown', 'unknown']);
    // A reported child keeps its own status either way.
    expect(threadSubagentRows(items, [child('c1', 0, 'a', 'running')], false).map((r) => r.status)).toEqual(['running', 'unknown']);
  });

  it('ignores other tools and status calls', () => {
    const items = [launch('c1', ['a'], { args: { action: 'status' }, summary: 'subagent  status' }), { ...launch('c2', ['a']), name: 'bash' }];
    expect(threadSubagentRows(items, [], true)).toEqual([]);
  });
});

describe('tray life cycle', () => {
  const items = [launch('c1', ['a', 'b', 'c'])];
  const rows = (a: SubagentRunStatus, b: SubagentRunStatus, c: SubagentRunStatus) =>
    threadSubagentRows(items, [child('c1', 0, 'a', a), child('c1', 1, 'b', b), child('c1', 2, 'c', c)], true);

  it('stays away while nothing runs (a finished thread opened later)', () => {
    const { memory, view } = step(EMPTY_TRAY, rows('done', 'failed', 'done'), 0);
    expect(memory).toBe(EMPTY_TRAY);
    expect(view).toBeNull();
  });

  it('shows running rows with live counts, then the finish moment, then goes', () => {
    let s = step(EMPTY_TRAY, rows('running', 'running', 'running'), 0);
    expect(s.view).toMatchObject({ phase: 'running', status: 'running', label: '3 subagents running', more: 0, expiresAt: null });
    expect(s.view!.rows.map((r) => r.name)).toEqual(['a', 'b', 'c']);

    s = step(s.memory, rows('done', 'running', 'running'), 1000);
    expect(s.view!.label).toBe('3 subagents · 2 running · 1 done');
    expect(s.view!.rows.map((r) => r.name)).toEqual(['b', 'c']);

    s = step(s.memory, rows('done', 'done', 'done'), 2000);
    expect(s.view).toMatchObject({ phase: 'finished', status: 'done', label: 'All 3 done', rows: [], expiresAt: 2000 + FINISH_LINGER_MS });

    // Still there just before the moment ends; gone after.
    s = step(s.memory, rows('done', 'done', 'done'), 2000 + FINISH_LINGER_MS - 1);
    expect(s.view?.label).toBe('All 3 done');
    s = step(s.memory, rows('done', 'done', 'done'), 2000 + FINISH_LINGER_MS);
    expect(s.memory).toBe(EMPTY_TRAY);
    expect(s.view).toBeNull();
  });

  it('keeps a failure up, in red, until it is opened', () => {
    let s = step(EMPTY_TRAY, rows('running', 'running', 'running'), 0);
    s = step(s.memory, rows('done', 'failed', 'running'), 1000);
    expect(s.view!.segments).toEqual([{ text: '3 subagents' }, { text: '1 running' }, { text: '1 done' }, { text: '1 failed', tone: 'danger' }]);
    expect(s.view!.rows.map((r) => [r.name, r.status])).toEqual([
      ['b', 'failed'],
      ['c', 'running'],
    ]);

    s = step(s.memory, rows('done', 'failed', 'done'), 2000);
    expect(s.view).toMatchObject({ phase: 'finished', status: 'failed', label: '2 done · 1 failed', expiresAt: null });
    s = step(s.memory, rows('done', 'failed', 'done'), 60_000);
    expect(s.view!.rows.map((r) => r.name)).toEqual(['b']);

    // Opening it lets go; the finish moment is long over, so the tray goes at once.
    s = step(ackTray(s.memory, ['p~sa~b']), rows('done', 'failed', 'done'), 61_000);
    expect(s.memory).toBe(EMPTY_TRAY);
    expect(s.view).toBeNull();
  });

  it('a new prompt puts every failure behind the user', () => {
    let s = step(EMPTY_TRAY, rows('running', 'running', 'running'), 0);
    const failed = rows('failed', 'failed', 'running');
    s = step(s.memory, failed, 1000);
    const acked = ackTrayFailures(s.memory, failed);
    expect(acked.acked).toEqual(['p~sa~a', 'p~sa~b']);
    expect(ackTrayFailures(acked, failed)).toBe(acked);
    s = step(acked, failed, 1500);
    expect(s.view!.rows.map((r) => r.name)).toEqual(['c']);
    expect(s.view!.label).toBe('3 subagents · 1 running · 2 failed');
    // The last one finishes: the finish moment shows, then the tray goes.
    s = step(s.memory, rows('failed', 'failed', 'done'), 2000);
    expect(s.view).toMatchObject({ label: '1 done · 2 failed', rows: [], expiresAt: 2000 + FINISH_LINGER_MS });
    s = step(s.memory, rows('failed', 'failed', 'done'), 2000 + FINISH_LINGER_MS);
    expect(s.view).toBeNull();
  });

  it('counts every launch in play, not only the latest, and restarts the clock when one starts', () => {
    const two = [launch('c1', ['a', 'b']), user('u2'), launch('c2', ['c', 'd'])];
    const kids = (a: SubagentRunStatus, b: SubagentRunStatus, c?: SubagentRunStatus, d?: SubagentRunStatus) =>
      threadSubagentRows(
        two,
        [child('c1', 0, 'a', a), child('c1', 1, 'b', b), ...(c ? [child('c2', 0, 'c', c)] : []), ...(d ? [child('c2', 1, 'd', d)] : [])],
        true,
      );
    let s = step(EMPTY_TRAY, kids('done', 'running'), 0);
    // The second launch has no children reported yet (its call is done, so nothing runs there).
    expect(s.view!.label).toBe('2 subagents · 1 running · 1 done');
    s = step(s.memory, kids('done', 'done'), 1000);
    expect(s.view!.label).toBe('All 2 done');
    s = step(s.memory, kids('done', 'done', 'running', 'running'), 2000);
    expect(s.memory.episode).toEqual(['c1', 'c2']);
    expect(s.view).toMatchObject({ phase: 'running', label: '4 subagents · 2 running · 2 done', expiresAt: null });
  });

  it('caps the rows and says how many more', () => {
    const many = [launch('c1', ['a', 'b', 'c', 'd', 'e'])];
    const all = threadSubagentRows(many, ['a', 'b', 'c', 'd', 'e'].map((n, i) => child('c1', i, n, 'running')), true);
    const s = step(EMPTY_TRAY, all, 0);
    expect(s.view!.rows.map((r) => r.name)).toEqual(['a', 'b']);
    expect(s.view!.more).toBe(3);
    expect(trayView(s.memory, all, 2)).toMatchObject({ more: 4 });
    expect(trayView(s.memory, all, 2)!.rows.map((r) => r.name)).toEqual(['a']);
    // Exactly as many as the slots: no "+1 more" standing in for the row itself.
    expect(trayView(s.memory, all.slice(0, 3), 3)).toMatchObject({ more: 0 });
    expect(trayView(s.memory, all.slice(0, 3), 3)!.rows).toHaveLength(3);
    // A cap below two still leaves a row and the "+N more".
    expect(trayView(s.memory, all, 1)!.rows).toHaveLength(1);
  });

  it('says a single subagent finished plainly, and stopped runs as stopped', () => {
    const one = [launch('c1', ['a'])];
    let s = step(EMPTY_TRAY, threadSubagentRows(one, [child('c1', 0, 'a', 'running')], true), 0);
    expect(s.view!.label).toBe('1 subagent running');
    s = step(s.memory, threadSubagentRows(one, [child('c1', 0, 'a', 'done')], true), 1);
    expect(s.view!.label).toBe('Subagent done');
    s = step(EMPTY_TRAY, rows('running', 'running', 'running'), 0);
    s = step(s.memory, rows('done', 'killed', 'done'), 1);
    expect(s.view).toMatchObject({ status: 'done', label: '2 done · 1 stopped' });
  });

  it('goes at once when nothing actually finished (background launch on an older hub)', () => {
    const bg = launch('c1', ['a', 'b'], { status: 'running' });
    let s = step(EMPTY_TRAY, threadSubagentRows([bg], [], true), 0);
    expect(s.view!.label).toBe('2 subagents running');
    expect(s.view!.rows.every((r) => !r.sessionId)).toBe(true);
    // The call returns "launched in the background": nothing more is known.
    s = step(s.memory, threadSubagentRows([{ ...bg, status: 'ok' }], [], true), 900);
    expect(s.memory).toBe(EMPTY_TRAY);
    expect(s.view).toBeNull();
  });

  it('returns the same memory when nothing changed', () => {
    const s = step(EMPTY_TRAY, rows('running', 'done', 'done'), 0);
    expect(advanceTray(s.memory, rows('running', 'done', 'done'), 5000)).toBe(s.memory);
    expect(advanceTray(EMPTY_TRAY, [], 0)).toBe(EMPTY_TRAY);
    expect(ackTray(s.memory, [])).toBe(s.memory);
  });
});
