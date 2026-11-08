/**
 * The saved model and effort for new threads (Prefs.newThread), resolved against the models one
 * computer offers. Pure: the New-thread screen, its model sheet and Settings all read from here.
 */

import type { ModelsResult } from './client';
import type { ModelInfo } from './protocol';
import type { NewThreadDefault, SavedModel } from './storage';

export type NewThreadChoice = {
  /** Model to send with session.spawn; null = the computer's phi default. */
  model: SavedModel | null;
  /** Level to send with session.spawn; null = phi's default. */
  thinkingLevel: string | null;
  /** The level in effect (saved, else the computer's default); undefined when effort does not apply. */
  effort: string | undefined;
  /** The model that will run reasons, so effort applies (unknown counts as yes). */
  reasoning: boolean;
  /** The saved model is not offered by this computer: its default runs instead. */
  unavailable: boolean;
  /** Model name for the composer pill ("Claude Opus 5.5", "Claude Sonnet 5 (default)"). */
  name: string;
  /** "Claude Opus 5.5 · high". */
  label: string;
};

const same = (a: { provider: string; id: string }, b: { provider: string; id: string }) => a.provider === b.provider && a.id === b.id;

export const savedModelName = (m: SavedModel) => m.name || m.id;

/** phi's levels for any reasoning model (what a hub lists when it has no default model). */
const BASE_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'];

/**
 * Effort levels to offer for a reasoning model. A hub lists the levels of its default model; when
 * that model does not reason (only "off"), phi's base levels instead (the hub takes any phi level
 * on session.spawn and the new session clamps it to its model).
 */
export function effortLevels(hub: ModelsResult | undefined): string[] | undefined {
  const levels = hub?.thinkingLevels;
  if (!levels) return undefined;
  return levels.length > 1 ? levels : BASE_LEVELS;
}

/** `hub` = that computer's `models.list` (no sessionId); undefined while not loaded. */
export function resolveNewThread(saved: NewThreadDefault | undefined, hub: ModelsResult | undefined): NewThreadChoice {
  const list = hub?.models;
  const hubDefault = hub?.current && list ? list.find((m) => same(m, hub.current!)) : undefined;
  let model: SavedModel | null = null;
  let unavailable = false;
  if (saved?.model) {
    if (!list) {
      // Not loaded yet: send what was saved; the computer checks it.
      model = saved.model;
    } else {
      const found = list.find((m) => same(m, saved.model!));
      if (found) model = { provider: found.provider, id: found.id, name: found.name, reasoning: found.reasoning };
      else unavailable = true;
    }
  }
  const running: SavedModel | undefined = model ?? hubDefault;
  const reasoning = running?.reasoning ?? true;
  const levels = effortLevels(hub);
  const wanted = saved?.thinkingLevel;
  const thinkingLevel = reasoning && wanted && (!levels || levels.includes(wanted)) ? wanted : null;
  // The hub reports "off" as its level when its default model does not reason: not this model's.
  const hubLevel = hubDefault?.reasoning === false ? undefined : hub?.thinkingLevel;
  const effort = reasoning ? (thinkingLevel ?? hubLevel) : undefined;
  const name = model
    ? savedModelName(model)
    : hubDefault
      ? unavailable
        ? `${hubDefault.name} (default)`
        : hubDefault.name
      : 'Default model';
  return { model, thinkingLevel, effort, reasoning, unavailable, name, label: effort ? `${name} · ${effort}` : name };
}

/** Settings row: the saved default without any computer ("Claude Opus 5.5 · high", "Default"). */
export function describeNewThreadDefault(saved: NewThreadDefault | undefined): string {
  const name = saved?.model ? savedModelName(saved.model) : 'Default';
  const effort = saved?.model?.reasoning === false ? undefined : saved?.thinkingLevel;
  return effort ? `${name} · ${effort}` : name;
}

/** Applies a pick to the saved default; null clears that part. Undefined when nothing is left. */
export function updateNewThreadDefault(
  saved: NewThreadDefault | undefined,
  patch: { model?: ModelInfo | null; thinkingLevel?: string | null },
): NewThreadDefault | undefined {
  const next: NewThreadDefault = { ...saved };
  if (patch.model !== undefined) {
    if (patch.model) next.model = { provider: patch.model.provider, id: patch.model.id, name: patch.model.name, reasoning: patch.model.reasoning };
    else delete next.model;
  }
  if (patch.thinkingLevel !== undefined) {
    if (patch.thinkingLevel) next.thinkingLevel = patch.thinkingLevel;
    else delete next.thinkingLevel;
  }
  return next.model || next.thinkingLevel ? next : undefined;
}
