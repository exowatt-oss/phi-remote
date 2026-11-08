import { getDraft, moveDraft, saveDraft } from '../drafts';

describe('drafts', () => {
  it('carries a draft to the session that replaced its thread', () => {
    saveDraft('hub\nold', { text: 'keep me', attachments: [] });
    moveDraft('hub\nold', 'hub\nnew');
    expect(getDraft('hub\nnew').text).toBe('keep me');
    expect(getDraft('hub\nold').text).toBe('');
  });

  it('never overwrites a draft already on the new thread, and ignores empty moves', () => {
    saveDraft('a', { text: 'from a', attachments: [] });
    saveDraft('b', { text: 'already b', attachments: [] });
    moveDraft('a', 'b');
    expect(getDraft('b').text).toBe('already b');
    moveDraft('missing', 'c');
    expect(getDraft('c').text).toBe('');
    moveDraft('b', 'b');
    expect(getDraft('b').text).toBe('already b');
  });
});
