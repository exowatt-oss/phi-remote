import type { TranscriptItem } from '../protocol';
import { emptyTranscript, itemCopyText, orderedItems, transcriptReducer, type TranscriptAction } from '../transcript';

const user = (id: string, text = id): TranscriptItem => ({ id, ts: 1, kind: 'user', text });
const asst = (id: string, text: string, streaming?: boolean): TranscriptItem => ({
  id,
  ts: 2,
  kind: 'assistant',
  text,
  ...(streaming ? { streaming } : {}),
});

function run(...actions: TranscriptAction[]) {
  return actions.reduce(transcriptReducer, emptyTranscript);
}

describe('transcriptReducer', () => {
  it('applies a snapshot oldest → newest and de-duplicates ids', () => {
    const s = run({
      type: 'snapshot',
      items: [user('a'), asst('b', 'x'), asst('b', 'y')],
      hasMore: true,
      state: { status: 'idle' },
    });
    expect(s.order).toEqual(['a', 'b']);
    expect((s.byId.b as { text: string }).text).toBe('y');
    expect(s.phase).toBe('ready');
    expect(s.hasMore).toBe(true);
    expect(s.live).toEqual({ status: 'idle' });
  });

  it('appends unknown ids and replaces known ids in place', () => {
    let s = run({ type: 'snapshot', items: [user('a')], hasMore: false, state: { status: 'working' } });
    s = transcriptReducer(s, { type: 'upsert', item: asst('b', 'Hel', true) });
    s = transcriptReducer(s, { type: 'upsert', item: asst('b', 'Hello', true) });
    s = transcriptReducer(s, {
      type: 'upsert',
      item: { id: 't1', ts: 3, kind: 'tool', toolCallId: 'c1', name: 'bash', summary: 'bash  ls', status: 'running' },
    });
    s = transcriptReducer(s, { type: 'upsert', item: asst('b', 'Hello world') });
    expect(s.order).toEqual(['a', 'b', 't1']);
    expect(orderedItems(s).map((i) => i.id)).toEqual(['a', 'b', 't1']);
    expect(s.byId.b).toEqual(asst('b', 'Hello world'));
  });

  it('returns the same state for an identical upsert object', () => {
    const item = user('a');
    const s1 = run({ type: 'upsert', item });
    expect(transcriptReducer(s1, { type: 'upsert', item })).toBe(s1);
  });

  it('prepends history pages, skipping ids already present', () => {
    let s = run({ type: 'snapshot', items: [user('c'), user('d')], hasMore: true, state: { status: 'idle' } });
    s = transcriptReducer(s, { type: 'loadingOlder', value: true });
    s = transcriptReducer(s, { type: 'history', items: [user('a'), user('b'), user('c')], hasMore: false });
    expect(s.order).toEqual(['a', 'b', 'c', 'd']);
    expect(s.hasMore).toBe(false);
    expect(s.loadingOlder).toBe(false);
  });

  it('tracks live state, reset and errors', () => {
    let s = run({ type: 'snapshot', items: [user('a')], hasMore: false, state: { status: 'idle' } });
    s = transcriptReducer(s, { type: 'state', state: { status: 'working', activity: { tool: 'bash', summary: 'ls' } } });
    expect(s.live).toEqual({ status: 'working', activity: { tool: 'bash', summary: 'ls' } });
    s = transcriptReducer(s, { type: 'reset' });
    expect(s.phase).toBe('stale');
    expect(s.order).toEqual(['a']);
    s = transcriptReducer(s, { type: 'error', message: 'gone' });
    expect(s.phase).toBe('error');
    expect(s.error).toBe('gone');
  });

  it('keeps items on screen while reloading', () => {
    let s = run({ type: 'loading' });
    expect(s.phase).toBe('loading');
    s = transcriptReducer(s, { type: 'snapshot', items: [user('a')], hasMore: false, state: { status: 'idle' } });
    s = transcriptReducer(s, { type: 'loading' });
    expect(s.phase).toBe('ready');
    expect(s.order).toEqual(['a']);
  });
});

describe('itemCopyText', () => {
  it('copies tool summary plus output, and assistant errors', () => {
    expect(
      itemCopyText({ id: 't', ts: 0, kind: 'tool', toolCallId: 'c', name: 'bash', summary: 'bash  ls', status: 'ok', output: 'a\nb' }),
    ).toBe('bash  ls\n\na\nb');
    expect(itemCopyText({ id: 'x', ts: 0, kind: 'assistant', text: '', error: 'Overloaded' })).toBe('Overloaded');
  });
});
