/**
 * What the app already knows about each computer, read from its state: the computer's name,
 * the folders its sessions (live and stored) run in, and any slash-command list fetched for one
 * of its sessions. Models and recent folders come from the hub (services/dictionary.ts).
 */

import type { CommandInfo } from '../protocol';
import type { RemoteState } from '../store';

export type HubHarvest = { name: string; folders: string[]; commands?: CommandInfo[] };

export function harvestHubs(state: Pick<RemoteState, 'hostOrder' | 'hosts' | 'sessions' | 'history' | 'commands'>): Record<string, HubHarvest> {
  const out: Record<string, HubHarvest> = {};
  for (const hubId of state.hostOrder) {
    const host = state.hosts[hubId];
    if (!host) continue;
    const folders = new Set<string>();
    for (const s of Object.values(state.sessions[hubId] ?? {})) if (s.cwd) folders.add(s.cwd);
    for (const p of Object.values(state.history[hubId]?.byId ?? {})) if (p.cwd) folders.add(p.cwd);
    // Skills and prompt templates are per computer: any session's list will do; merge them all.
    let commands: CommandInfo[] | undefined;
    const prefix = `${hubId}\n`;
    for (const [key, entry] of Object.entries(state.commands)) {
      if (!key.startsWith(prefix) || entry.status !== 'ready' || !entry.commands.length) continue;
      const byName = new Map((commands ?? []).map((c) => [c.name, c]));
      for (const c of entry.commands) if (!byName.has(c.name)) byName.set(c.name, c);
      commands = [...byName.values()];
    }
    out[hubId] = { name: host.name, folders: [...folders], ...(commands ? { commands } : {}) };
  }
  return out;
}
