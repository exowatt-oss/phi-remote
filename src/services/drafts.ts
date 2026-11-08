/**
 * Composer drafts, kept in memory per thread so leaving and coming back keeps the text and
 * photos. Not persisted: a relaunch starts clean.
 */

import { createStore } from 'zustand/vanilla';

import type { Attachment } from './attachments';

export type Draft = { text: string; attachments: Attachment[] };

const EMPTY: Draft = { text: '', attachments: [] };

const draftStore = createStore<Record<string, Draft>>()(() => ({}));

export function getDraft(key: string): Draft {
  return draftStore.getState()[key] ?? EMPTY;
}

/** Carries a thread's draft to the session that replaced it (/new, /resume, /fork …). */
export function moveDraft(from: string, to: string): void {
  const draft = draftStore.getState()[from];
  if (!draft || from === to) return;
  saveDraft(from, EMPTY);
  if (!getDraft(to).text && getDraft(to).attachments.length === 0) saveDraft(to, draft);
}

export function saveDraft(key: string, draft: Draft): void {
  draftStore.setState((s) => {
    const next = { ...s };
    if (!draft.text && draft.attachments.length === 0) delete next[key];
    else next[key] = draft;
    return next;
  }, true);
}
