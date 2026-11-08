import type { ModelsResult } from '../client';
import { describeNewThreadDefault, effortLevels, resolveNewThread, updateNewThreadDefault } from '../new-thread';

const opus = { provider: 'anthropic', id: 'claude-opus-5-5', name: 'Claude Opus 5.5', reasoning: true };
const sonnet = { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5', reasoning: true };
const mini = { provider: 'openai', id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', reasoning: false };

const hub: ModelsResult = {
  models: [opus, sonnet, mini],
  current: { provider: 'anthropic', id: 'claude-sonnet-5' },
  thinkingLevel: 'medium',
  thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
};

describe('resolveNewThread', () => {
  it('nothing saved: the computer default model and level, nothing sent', () => {
    expect(resolveNewThread(undefined, hub)).toEqual({
      model: null,
      thinkingLevel: null,
      effort: 'medium',
      reasoning: true,
      unavailable: false,
      name: 'Claude Sonnet 5',
      label: 'Claude Sonnet 5 · medium',
    });
  });

  it('a saved model and effort the computer offers are sent and shown', () => {
    const c = resolveNewThread({ model: { provider: 'anthropic', id: 'claude-opus-5-5' }, thinkingLevel: 'high' }, hub);
    expect(c.model).toEqual(opus);
    expect(c.thinkingLevel).toBe('high');
    expect(c.label).toBe('Claude Opus 5.5 · high');
    expect(c.unavailable).toBe(false);
  });

  it('only effort saved: default model at that effort', () => {
    const c = resolveNewThread({ thinkingLevel: 'xhigh' }, hub);
    expect([c.model, c.thinkingLevel, c.label]).toEqual([null, 'xhigh', 'Claude Sonnet 5 · xhigh']);
  });

  it('falls back to the computer default when it does not offer the saved model, and says so', () => {
    const c = resolveNewThread({ model: { provider: 'ExampleCo', id: 'large', name: 'Large', reasoning: true }, thinkingLevel: 'high' }, hub);
    expect(c.model).toBeNull();
    expect(c.unavailable).toBe(true);
    expect(c.thinkingLevel).toBe('high');
    expect(c.label).toBe('Claude Sonnet 5 (default) · high');
    // …and without a known default model either
    const bare = resolveNewThread({ model: { provider: 'ExampleCo', id: 'large' } }, { ...hub, current: undefined, thinkingLevel: undefined });
    expect([bare.model, bare.unavailable, bare.label]).toEqual([null, true, 'Default model']);
  });

  it('drops an effort the computer does not offer (phi default instead)', () => {
    const c = resolveNewThread({ thinkingLevel: 'max' }, hub);
    expect(c.thinkingLevel).toBeNull();
    expect(c.effort).toBe('medium');
    // no list from the computer: phi's base levels
    expect(resolveNewThread({ thinkingLevel: 'xhigh' }, { ...hub, thinkingLevels: [] }).thinkingLevel).toBeNull();
    expect(resolveNewThread({ thinkingLevel: 'high' }, { ...hub, thinkingLevels: [] }).thinkingLevel).toBe('high');
  });

  it('a non-reasoning model gets no effort, sent or shown', () => {
    const c = resolveNewThread({ model: { provider: 'openai', id: 'gpt-4.1-mini' }, thinkingLevel: 'high' }, hub);
    expect([c.thinkingLevel, c.effort, c.reasoning, c.label]).toEqual([null, undefined, false, 'GPT-4.1 mini']);
    // the computer's default is non-reasoning
    const d = resolveNewThread({ thinkingLevel: 'high' }, { ...hub, current: { provider: 'openai', id: 'gpt-4.1-mini' }, thinkingLevel: 'off' });
    expect([d.thinkingLevel, d.label]).toEqual([null, 'GPT-4.1 mini']);
  });

  it('a computer whose default model does not reason still offers effort for a model that does', () => {
    const plain: ModelsResult = { ...hub, current: { provider: 'openai', id: 'gpt-4.1-mini' }, thinkingLevel: 'off', thinkingLevels: ['off'] };
    expect(effortLevels(plain)).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect(effortLevels(hub)).toEqual(hub.thinkingLevels);
    expect(effortLevels(undefined)).toBeUndefined();
    const c = resolveNewThread({ model: { provider: 'anthropic', id: 'claude-opus-5-5' }, thinkingLevel: 'high' }, plain);
    expect([c.thinkingLevel, c.effort, c.label]).toEqual(['high', 'high', 'Claude Opus 5.5 · high']);
    // no saved effort: phi's default level applies, which that hub cannot tell (it reports "off")
    const d = resolveNewThread({ model: { provider: 'anthropic', id: 'claude-opus-5-5' } }, plain);
    expect([d.thinkingLevel, d.effort, d.label]).toEqual([null, undefined, 'Claude Opus 5.5']);
  });

  it('before the models load, passes the saved choice through for the computer to check', () => {
    const saved = { model: { provider: 'ExampleCo', id: 'large', name: 'Large' }, thinkingLevel: 'high' };
    const c = resolveNewThread(saved, undefined);
    expect([c.model, c.thinkingLevel, c.unavailable, c.label]).toEqual([saved.model, 'high', false, 'Large · high']);
    expect(resolveNewThread(undefined, undefined).label).toBe('Default model');
  });
});

describe('new-thread default', () => {
  it('describes the saved default for Settings', () => {
    expect(describeNewThreadDefault(undefined)).toBe('Default');
    expect(describeNewThreadDefault({ thinkingLevel: 'high' })).toBe('Default · high');
    expect(describeNewThreadDefault({ model: { provider: 'a', id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }, thinkingLevel: 'high' })).toBe(
      'Claude Opus 5.5 · high',
    );
    expect(describeNewThreadDefault({ model: { provider: 'a', id: 'x-1' } })).toBe('x-1');
    expect(describeNewThreadDefault({ model: { provider: 'openai', id: 'm', name: 'Mini', reasoning: false }, thinkingLevel: 'high' })).toBe('Mini');
  });

  it('applies picks: model and effort independently, null clears, empty is undefined', () => {
    let d = updateNewThreadDefault(undefined, { thinkingLevel: 'high' });
    expect(d).toEqual({ thinkingLevel: 'high' });
    d = updateNewThreadDefault(d, { model: opus });
    expect(d).toEqual({ model: opus, thinkingLevel: 'high' });
    d = updateNewThreadDefault(d, { thinkingLevel: 'low' });
    expect(d).toEqual({ model: opus, thinkingLevel: 'low' });
    d = updateNewThreadDefault(d, { model: null });
    expect(d).toEqual({ thinkingLevel: 'low' });
    expect(updateNewThreadDefault(d, { thinkingLevel: null })).toBeUndefined();
  });
});
