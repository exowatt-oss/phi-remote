/**
 * (Runs with jest.integration.config.js: plain Node environment.)
 *
 * End-to-end check of the client layer against tools/mock-hub (opt-in):
 *   node tools/mock-hub/server.mjs --port 7718 --pair-code K7Q2M9XD --reusable-code --quiet --no-qr
 *   PHI_REMOTE_MOCK_HUB=http://127.0.0.1:7718 PHI_REMOTE_MOCK_CODE=K7Q2M9XD npm run test:mock-hub
 * Uses Node's global WebSocket and fetch. Skipped unless PHI_REMOTE_MOCK_HUB is set.
 */
import { RemoteClient } from '../client';
import type { SocketLike } from '../connection';
import { fetchHubInfo, pairWithHub, type FetchLike } from '../pairing';
import { HostStorage, MemoryKV } from '../storage';
import { splitLeadingCommand } from '../commands';
import { HubError, type ToolItem } from '../protocol';
import { groupByProject, selectCommands, selectTranscript, transcriptKey } from '../store';
import { childrenOf, parentCounts, subagentRows } from '../subagents';
import { advanceTray, EMPTY_TRAY, threadSubagentRows, trayView } from '../subagent-tray';
import { orderedItems } from '../transcript';
import { HistoryCache, MemoryFiles } from '../history-cache';
import { historyView, nestHistory } from '../history';
import { mergeBoard, overseerCall, overseerEvents, overseerName, overseerPrompt, threadReport, DEFAULT_OVERSEER, addThreadPrompt } from '../overseer';
import { compileDictionary, correctDictation, harvestHubs, mergeHubVocabulary } from '../dictionary';

const HUB_URL = process.env.PHI_REMOTE_MOCK_HUB;
const CODE = process.env.PHI_REMOTE_MOCK_CODE ?? 'K7Q2M9XD';
const maybe = HUB_URL ? describe : describe.skip;

const fetchImpl = globalThis.fetch as unknown as FetchLike;
const createSocket = (url: string) => new (globalThis as unknown as { WebSocket: new (u: string) => SocketLike }).WebSocket(url);

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 10_000, what = ''): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting${what ? ` for ${what}` : ''}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

maybe('client against tools/mock-hub', () => {
  jest.setTimeout(60_000);
  let client: RemoteClient;

  afterAll(() => client?.dispose());

  it('pairs, lists sessions, streams a transcript, prompts, and loads history', async () => {
    const info = await fetchHubInfo(fetchImpl, HUB_URL!);
    expect(info?.protocol).toBe(1);
    const paired = await pairWithHub(
      { urls: ['http://127.0.0.1:1', HUB_URL!], code: CODE.toLowerCase().replace(/(....)/, '$1-'), hubId: info!.hubId, deviceName: 'jest' },
      { fetch: fetchImpl },
    );
    expect(paired.preferredUrl).toBe(HUB_URL);

    client = new RemoteClient({
      storage: new HostStorage(new MemoryKV()),
      createSocket,
      fetch: fetchImpl,
      app: { version: '0.1.0', build: 'test' },
      deviceName: 'jest',
    });
    await client.init();
    await client.addHost(paired);
    await waitFor(() => client.store.getState().hosts[paired.hubId]?.conn.status === 'live');
    await waitFor(() => client.store.getState().sessionsLoaded[paired.hubId]);

    const projects = groupByProject(client.store.getState());
    expect(projects.length).toBeGreaterThan(0);
    const all = projects.flatMap((p) => p.sessions);
    // Not the mock's subagent parent (tools/mock-hub/subagents.mjs): /new below would take its
    // subagents away, and they are checked in the next test.
    const idle = all.find((s) => s.status === 'idle' && s.kind === 'interactive' && s.name !== 'Subagents in phi remote' && !s.isOverseer);
    expect(idle).toBeTruthy();

    client.subscribe(paired.hubId, idle!.sessionId);
    const t = await waitFor(() => {
      const tr = selectTranscript(client.store.getState(), paired.hubId, idle!.sessionId);
      return tr.phase === 'ready' ? tr : null;
    });
    expect(t.order.length).toBeGreaterThan(0);
    if (t.hasMore) {
      const before = t.order.length;
      await client.loadOlder(paired.hubId, idle!.sessionId);
      expect(selectTranscript(client.store.getState(), paired.hubId, idle!.sessionId).order.length).toBeGreaterThan(before);
    }

    const models = await client.listModels(paired.hubId, idle!.sessionId);
    expect(models.models.length).toBeGreaterThan(0);
    // Clarification 8: models.list without a sessionId answers from the hub's registry.
    const registry = await client.listModels(paired.hubId).catch((err: Error) => err);
    if (registry instanceof Error) console.warn(`models.list without sessionId failed: ${registry.message}`);
    else expect(Array.isArray(registry.models)).toBe(true);
    const cwds = await client.recentCwds(paired.hubId);
    expect(Array.isArray(cwds)).toBe(true);

    const count = selectTranscript(client.store.getState(), paired.hubId, idle!.sessionId).order.length;
    await client.prompt(paired.hubId, idle!.sessionId, 'integration test ping');
    await waitFor(() => selectTranscript(client.store.getState(), paired.hubId, idle!.sessionId).order.length > count);
    await client.abort(paired.hubId, idle!.sessionId);

    client.setFocus({ hubId: paired.hubId, sessionId: idle!.sessionId });
    client.setFocus(null);

    // Slash commands (v1 addition): the list, a skill run, then /new replacing the session.
    client.ensureCommands(paired.hubId, idle!.sessionId);
    const commands = await waitFor(() => {
      const list = selectCommands(client.store.getState(), paired.hubId, idle!.sessionId);
      return list.length ? list : null;
    });
    expect(commands.map((c) => c.name)).toEqual(expect.arrayContaining(['new', 'compact', 'name', 'skill:use-subs']));
    expect(commands.every((c) => c.source !== 'skill' || c.name.startsWith('skill:'))).toBe(true);

    // The dictation dictionary, assembled from what this computer reports: its commands (as the
    // app harvests them), models and recent folders.
    const harvested = harvestHubs(client.store.getState())[paired.hubId];
    const vocabulary = mergeHubVocabulary(undefined, { ...harvested, models: models.models, folders: [...harvested.folders, ...cwds] }, Date.now());
    expect(vocabulary.commands.map((c) => c.name)).toEqual(expect.arrayContaining(['skill:jev-mobile', 'skill:example-skill', 'jev']));
    const dictionary = compileDictionary({ words: [], hubs: [vocabulary] });
    expect(correctDictation('forward slash Jeff mobile book the trip', dictionary)).toBe('/jev-mobile book the trip');
    expect(correctDictation('slash example skill on the exampleco site', dictionary)).toBe('/example-skill on the exampleco site');
    expect(dictionary.contextualStrings).toEqual(expect.arrayContaining(['jev-mobile', 'example-skill', 'phi-remote']));

    await waitFor(() => selectTranscript(client.store.getState(), paired.hubId, idle!.sessionId).live?.status === 'idle', 20_000);
    await client.prompt(paired.hubId, idle!.sessionId, '/skill:use-subs ship the plan');
    const userItem = await waitFor(() => {
      const tr = selectTranscript(client.store.getState(), paired.hubId, idle!.sessionId);
      return tr.order.map((id) => tr.byId[id]).find((it) => it?.kind === 'user' && it.text.includes('ship the plan'));
    });
    expect(splitLeadingCommand(userItem.kind === 'user' ? userItem.text : '')).toEqual({ name: 'skill:use-subs', label: 'use-subs', rest: 'ship the plan' });
    await client.abort(paired.hubId, idle!.sessionId);

    await client.prompt(paired.hubId, idle!.sessionId, '/new');
    const replacement = await waitFor(() => client.store.getState().replacements[transcriptKey(paired.hubId, idle!.sessionId)]);
    await waitFor(() => client.store.getState().sessions[paired.hubId]?.[replacement]);
    expect(client.store.getState().sessions[paired.hubId]?.[idle!.sessionId]).toBeUndefined();
    client.subscribe(paired.hubId, replacement);
    const fresh = await waitFor(() => {
      const tr = selectTranscript(client.store.getState(), paired.hubId, replacement);
      return tr.phase === 'ready' ? tr : null;
    });
    expect(fresh.order).toEqual([]);
  });

  it('gets subagent sessions (hello.features), matches them to the launch, steers and refuses', async () => {
    const hubId = client.store.getState().hostOrder[0];
    // The mock launches its first round ~3 s after start; ws-a/ws-b end within ~25 s.
    const parent = await waitFor(() => Object.values(client.store.getState().sessions[hubId] ?? {}).find((s) => s.subagents && s.subagents.total >= 3), 20_000);
    const listed = groupByProject(client.store.getState()).flatMap((p) => p.sessions);
    expect(listed.some((s) => s.kind === 'subagent')).toBe(false);
    const kids = childrenOf(client.store.getState().sessions[hubId], parent.sessionId);
    expect(kids.length).toBeGreaterThanOrEqual(3);
    expect(kids.every((k) => k.subagent && k.parentSessionId === parent.sessionId)).toBe(true);
    expect(parentCounts(parent.subagents, kids)?.total).toBe(parent.subagents!.total);

    client.subscribe(hubId, parent.sessionId);
    const launch = await waitFor(() => {
      const tr = selectTranscript(client.store.getState(), hubId, parent.sessionId);
      return tr.order.map((id) => tr.byId[id]).find((it): it is ToolItem => it?.kind === 'tool' && it.name === 'subagent');
    });
    const rows = subagentRows(launch, kids)!;
    expect(rows.map((r) => r.name)).toEqual(['scout', 'ws-b', 'ws-c']);
    expect(rows.every((r) => r.sessionId)).toBe(true);

    // The pinned tray: both launches of the turn, in order, capped with "+N more".
    const all = await waitFor(() => {
      const s = client.store.getState();
      const list = threadSubagentRows(orderedItems(selectTranscript(s, hubId, parent.sessionId)), childrenOf(s.sessions[hubId], parent.sessionId), true);
      return list.filter((r) => r.sessionId).length >= 5 ? list : null;
    }, 15_000, 'the second launch');
    expect(all.map((r) => r.name)).toEqual(['scout', 'ws-b', 'ws-c', 'lint-fix', 'docs']);
    expect(new Set(all.map((r) => r.launch)).size).toBe(2);
    const view = trayView(advanceTray(EMPTY_TRAY, all, Date.now()), all, 3)!;
    expect(view.phase).toBe('running');
    expect(view.counts.total).toBe(5);
    expect(view.rows.length + view.more).toBe(all.filter((r) => r.status === 'running' || r.status === 'failed').length);

    const running = await waitFor(() => childrenOf(client.store.getState().sessions[hubId], parent.sessionId).find((k) => k.subagent?.status === 'running'));
    client.subscribe(hubId, running.sessionId);
    const first = await waitFor(() => {
      const tr = selectTranscript(client.store.getState(), hubId, running.sessionId);
      return tr.phase === 'ready' && tr.order.length ? tr.byId[tr.order[0]] : null;
    });
    expect(first).toMatchObject({ id: 'u:task', kind: 'user' });
    // A run that is still starting refuses messages ("not accepting messages yet"): retry.
    await waitFor(() => Date.now() - (running.subagent?.startedAt ?? 0) > 2000, 5000);
    await client.prompt(hubId, running.sessionId, 'also check ratelimit.ts', [], 'steer');
    await waitFor(() => {
      const tr = selectTranscript(client.store.getState(), hubId, running.sessionId);
      return tr.order.some((id) => tr.byId[id]?.kind === 'user' && (tr.byId[id] as { text: string }).text === 'also check ratelimit.ts');
    });

    const finished = await waitFor(
      () => childrenOf(client.store.getState().sessions[hubId], parent.sessionId).find((k) => k.subagent && k.subagent.status !== 'running'),
      40_000,
    );
    const refused = await client.prompt(hubId, finished.sessionId, 'hello?').catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(HubError);
    expect((refused as HubError).code).toBe('bad_request');
    await expect(client.listModels(hubId, finished.sessionId)).rejects.toBeInstanceOf(HubError);
  });

  it('overseers: nesting, board, transcript cards, start one from the phone, add a thread', async () => {
    const hubId = client.store.getState().hostOrder[0];
    expect(client.hasOverseer(hubId)).toBe(true);
    const sessions = () => client.store.getState().sessions[hubId];
    const overseer = await waitFor(() => Object.values(sessions()).find((s) => s.isOverseer && s.name.startsWith('Overseer · ship')), 10_000, 'the overseer');
    expect(overseer.threadCounts?.total).toBe(4);
    // Home: its live threads nest under it and are not rows of their own.
    const projects = groupByProject(client.store.getState());
    const top = projects.flatMap((p) => p.sessions.map((s) => s.sessionId));
    const nested = projects.flatMap((p) => p.threads[overseer.sessionId] ?? []);
    expect(nested.map((s) => s.overseer?.thread).sort()).toEqual(['api-filters', 'board-ui', 'migrations']);
    for (const t of nested) expect(top).not.toContain(t.sessionId);
    // The board: four threads (docs-sweep closed), live summaries laid over.
    const board = await client.overseerBoard(hubId, overseer.sessionId);
    const merged = mergeBoard(board, sessions(), overseer.sessionId);
    expect(merged.map((t) => [t.name, t.state, t.live])).toEqual([
      ['api-filters', 'running', true],
      ['board-ui', 'running', true],
      ['migrations', 'running', true],
      ['docs-sweep', 'closed', false],
    ]);
    expect(merged.find((t) => t.name === 'migrations')?.lastError).toMatch(/429/);
    // Its transcript: spawn cards, updates and a report, parsed from the real shapes.
    client.subscribe(hubId, overseer.sessionId);
    const tr = await waitFor(() => {
      const x = selectTranscript(client.store.getState(), hubId, overseer.sessionId);
      return x.phase === 'ready' ? x : null;
    });
    const items = orderedItems(tr);
    const calls = items.flatMap((i) => (i.kind === 'tool' ? [overseerCall(i)] : [])).filter(Boolean);
    expect(calls.filter((c) => c!.action === 'spawn').map((c) => c!.title)).toEqual(['Started api-filters', 'Started board-ui', 'Started migrations', 'Started docs-sweep']);
    expect(calls.find((c) => c!.action === 'spawn')?.meta).toBe('Opus 5.5 high · FORCA tab');
    const events = items.flatMap((i) => (i.kind === 'note' ? (overseerEvents(i) ?? []) : []));
    expect(events.map((e) => `${e.thread || 'heartbeat'}:${e.kind}`)).toEqual(['docs-sweep:idle', 'migrations:error', 'board-ui:idle', 'heartbeat:heartbeat']);
    const reports = items.flatMap((i) => (i.kind === 'note' ? [threadReport(i)].filter(Boolean) : []));
    expect(reports.map((r) => `${r!.thread}:${r!.kind}`)).toEqual(['docs-sweep:done', 'board-ui:question']);
    // Past sessions: a stored overseer with three stored threads nests them.
    await waitFor(() => (client.store.getState().history[hubId]?.order.length ?? 0) > 0, 10_000, 'history');
    const s = client.store.getState();
    const view = historyView({ hosts: [{ hubId, name: s.hosts[hubId].name, connected: true }], history: s.history, live: s.sessions, hubId: null, query: '', search: null });
    const nest = nestHistory(view.rows, () => false);
    const past = nest.find((i) => i.row.session.title === 'Overseer · nightly dependency bumps');
    if (past) expect(past.nest?.overseer?.threads).toBe(3);

    // Start an overseer from the phone; the mock starts two threads for it.
    const goal = 'Tidy the fleet API';
    const id = await client.spawn(hubId, {
      cwd: overseer.cwd,
      name: overseerName(goal),
      prompt: overseerPrompt({ goal, defaults: DEFAULT_OVERSEER, command: 'skill:overseer' }),
    });
    expect(await waitFor(() => sessions()[id]?.name)).toBe('Overseer · Tidy the fleet API');
    await waitFor(() => (sessions()[id]?.threadCounts?.total ?? 0) >= 2, 15_000, 'two threads');
    // Add a thread.
    await client.prompt(hubId, id, addThreadPrompt('Write the release notes', DEFAULT_OVERSEER), [], 'auto');
    let mine = await client.overseerBoard(hubId, id);
    for (let i = 0; i < 60 && mine.threads.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 250));
      mine = await client.overseerBoard(hubId, id);
    }
    expect(mine.threads.map((t) => t.name)).toEqual(['research', 'implement', 'write-the-release-notes']);
    for (const t of mine.threads) await client.closeSession(hubId, t.sessionId).catch(() => undefined);
    await client.closeSession(hubId, id);
  });

  it('session history: merged list, paging, search, stored transcript, resume in place, cache', async () => {
    const hubId = client.store.getState().hostOrder[0];
    const name = client.store.getState().hosts[hubId].name;
    expect(client.hasHistory(hubId)).toBe(true);
    await waitFor(() => (client.store.getState().history[hubId]?.order.length ?? 0) > 0, 10_000, 'first page');
    const hosts = () => [{ hubId, name, connected: true }];
    const view = () => {
      const s = client.store.getState();
      return historyView({ hosts: hosts(), history: s.history, live: s.sessions, hubId: null, query: '', search: null });
    };
    const firstRows = view().rows.length;
    expect(view().loadMore).toEqual([hubId]);
    await client.loadMorePast([hubId]);
    expect(view().rows.length).toBeGreaterThan(firstRows);
    // Newest first, no duplicates, running sessions marked.
    const rows = view().rows;
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(rows.every((r, i) => i === 0 || rows[i - 1].at >= r.at)).toBe(true);
    expect(rows.some((r) => r.running)).toBe(true);

    // Search across message text goes to the hub; results merge in.
    client.search('retries');
    await waitFor(() => {
      const hit = client.store.getState().search?.hubs[hubId];
      return hit && !hit.loading ? hit : null;
    }, 10_000, 'search');
    expect(client.store.getState().search!.hubs[hubId].ids.length).toBeGreaterThan(0);
    client.search('');

    // A stored, resumable session: transcript first (paged up with before), then resume in place.
    // Not one the first test opened (its transcript is still subscribed there).
    const opened = client.store.getState().transcripts;
    const stored = rows.find((r) => !r.running && r.session.resumable && r.session.messageCount > 4 && !(transcriptKey(hubId, r.session.sessionId) in opened))!;
    expect(stored).toBeTruthy();
    const sid = stored.session.sessionId;
    const release = client.subscribe(hubId, sid);
    const t = await waitFor(() => {
      const tr = selectTranscript(client.store.getState(), hubId, sid);
      return tr.phase === 'ready' && tr.source === 'stored' ? tr : null;
    }, 10_000, 'stored transcript');
    const storedIds = [...t.order];
    if (t.hasMore) {
      await client.loadOlder(hubId, sid);
      expect(selectTranscript(client.store.getState(), hubId, sid).order.length).toBeGreaterThan(storedIds.length);
    }
    const beforeResume = [...selectTranscript(client.store.getState(), hubId, sid).order];
    const liveId = await client.resume(hubId, sid, { prompt: 'integration: continue please' });
    expect(liveId).toBe(sid);
    const after = await waitFor(() => {
      const tr = selectTranscript(client.store.getState(), hubId, sid);
      return tr.source === 'live' && tr.order.length > beforeResume.length ? tr : null;
    }, 20_000, 'live after resume');
    // Same items, in the same order, then the new turn; nothing repeated.
    expect(after.order.slice(0, beforeResume.length)).toEqual(beforeResume);
    expect(new Set(after.order).size).toBe(after.order.length);
    expect(client.store.getState().sessions[hubId][sid]).toBeTruthy();
    release();

    // `resumable: false` never gates: the flagged fixture resumes, and the deleted folder resumes
    // elsewhere with a quiet note (ack cwd + cwdFallback).
    await client.loadMorePast([hubId]);
    const all = Object.values(client.store.getState().history[hubId].byId);
    const flagged = all.find((x) => x.cwd === '/opt/legacy-tools/scada-export' && !x.live)!;
    expect(flagged).toBeTruthy();
    await expect(client.resume(hubId, flagged.sessionId, { prompt: 'integration: flagged' })).resolves.toBe(flagged.sessionId);
    expect(client.store.getState().resumeNotes[transcriptKey(hubId, flagged.sessionId)]).toBeUndefined();
    const gone = all.find((x) => x.cwd.endsWith('/scratch/old-spike') && !x.live)!;
    expect(gone).toBeTruthy();
    await expect(client.resume(hubId, gone.sessionId)).resolves.toBe(gone.sessionId);
    expect(client.store.getState().resumeNotes[transcriptKey(hubId, gone.sessionId)]).toMatch(/^Folder .*scratch\/old-spike is gone; resumed in /);
  });

  it('session history: the phone copy lists and opens sessions while the computer is away', async () => {
    const files = new MemoryFiles();
    const cache = new HistoryCache(files);
    const hubId = client.store.getState().hostOrder[0];
    const history = client.store.getState().history;
    await cache.saveIndex(history, Date.now());
    const sid = history[hubId].order.find((id) => !client.store.getState().sessions[hubId]?.[id])!;
    await cache.saveTranscript(hubId, sid, [{ id: 'x1', ts: 1, kind: 'user', text: 'cached' }], false, Date.now());
    const reread = new HistoryCache(files);
    const loaded = await reread.load();
    expect(loaded[hubId].order.slice(0, 10)).toEqual(history[hubId].order.slice(0, 10));
    expect((await reread.loadTranscript(hubId, sid))?.items.map((i) => i.id)).toEqual(['x1']);
  });

});
