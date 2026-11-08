import { base64Bytes, expandHome, fitWithin, inferHome, lastSeen, modelLabel, plainPreview, relativeTime, sessionHref, shortCwd, splitToolSummary } from '../format';
import { decodeEntities, inlineText, parseMarkdown, TABLE_CELL, tableColumnWidths, textAdvance } from '../markdown';
import { notificationTarget, parseSessionLink } from '../notification-target';
import { chunkSpeech, pickBestVoice, speakableText, voiceLabel, voiceQuality, type VoiceLike } from '../speech';
import { hostStorageKey, HostStorage, MemoryKV, parseNewThreadDefault } from '../storage';

describe('format', () => {
  it('shortens home directories', () => {
    expect(shortCwd('/Users/Alex/ExampleCo/phi')).toBe('~/ExampleCo/phi');
    expect(shortCwd('/home/dev')).toBe('~');
    expect(shortCwd('/root/x')).toBe('~/x');
    expect(shortCwd('/opt/app')).toBe('/opt/app');
  });

  it('reduces markdown to a plain one-line preview', () => {
    expect(plainPreview('The login test hung because `vi.useFakeTimers()` froze **the** timer.')).toBe(
      'The login test hung because vi.useFakeTimers() froze the timer.',
    );
    expect(plainPreview('Three files:\n\n| File | Change |\n|---|:---:|\n| `hub.ts` | timeout |')).toBe(
      'Three files: File · Change · hub.ts · timeout',
    );
    // One-line preview as the hub sends it.
    expect(plainPreview('Three files: | File | Change | |---|---| | `src/hub.ts` | hello timeout | | `push.ts` | **untracked** |')).toBe(
      'Three files: File · Change · src/hub.ts · hello timeout · push.ts · untracked',
    );
    expect(plainPreview('use a || b here')).toBe('use a || b here');
    expect(plainPreview('Added `closes 4401`: ```ts it("closes") ``` Suite is green.')).toBe('Added closes 4401: it("closes") Suite is green.');
    expect(plainPreview('## Done\n- [x] see [the PR](https://x.y/1)\n```ts\nconst a = 1;\n```')).toBe('Done see the PR const a = 1;');
    expect(plainPreview(undefined)).toBe('');
  });

  it('formats relative times', () => {
    const now = new Date(2026, 9, 29, 12).getTime();
    expect(relativeTime(now - 10_000, now)).toBe('now');
    expect(relativeTime(now - 4 * 60_000, now)).toBe('4m');
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe('2h');
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe('3d');
    expect(relativeTime(new Date(2026, 9, 3).getTime(), now)).toBe('Oct 3');
    expect(relativeTime(new Date(2025, 0, 2).getTime(), now)).toBe('Jan 2, 2025');
    expect(lastSeen(now - 5 * 60_000, now)).toBe('Seen 5m ago');
    expect(lastSeen(null, now)).toBe('Not seen yet');
  });

  it('infers the remote home and expands ~', () => {
    const home = inferHome(['/opt/x', '/Users/Alex/ExampleCo/phi']);
    expect(home).toBe('/Users/Alex');
    expect(expandHome('~/ExampleCo/site', home)).toBe('/Users/Alex/ExampleCo/site');
    expect(expandHome('~', home)).toBe('/Users/Alex');
    expect(expandHome(' /tmp/x ', home)).toBe('/tmp/x');
    expect(expandHome('~/x', null)).toBe('~/x');
    expect(inferHome(['/home/dev/a'])).toBe('/home/dev');
    expect(inferHome([])).toBeNull();
  });

  it('fits images within 1600 px on the long side', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(1000, 3000)).toEqual({ width: 533, height: 1600 });
    expect(fitWithin(1600, 900)).toBeNull();
  });

  it('labels models, builds hrefs, sizes base64, splits tool summaries', () => {
    expect(modelLabel({ provider: 'a', id: 'x/claude-opus' })).toBe('claude-opus');
    expect(modelLabel({ provider: 'a', id: 'x', name: 'Opus' })).toBe('Opus');
    expect(sessionHref('h/1', 's 2')).toBe('/session/h%2F1/s%202');
    expect(base64Bytes('AAAA')).toBe(3);
    expect(base64Bytes('AAA=')).toBe(2);
    expect(splitToolSummary('bash  ls -la', 'bash')).toEqual({ tool: 'bash', detail: 'ls -la' });
    expect(splitToolSummary('read', 'read')).toEqual({ tool: 'read', detail: '' });
    expect(splitToolSummary('src/app.ts', 'edit')).toEqual({ tool: 'edit', detail: 'src/app.ts' });
  });
});

describe('markdown', () => {
  it('parses paragraphs, emphasis, code, links and lists', () => {
    const blocks = parseMarkdown('Hello **bold** and *it* `code` [site](https://x.dev)\n\n- [x] done\n- todo\n\n```ts\nlet a = 1;\n```');
    expect(blocks).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: 'Hello ' },
          { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
          { type: 'text', text: ' and ' },
          { type: 'em', children: [{ type: 'text', text: 'it' }] },
          { type: 'text', text: ' ' },
          { type: 'code', text: 'code' },
          { type: 'text', text: ' ' },
          { type: 'link', href: 'https://x.dev', children: [{ type: 'text', text: 'site' }] },
        ],
      },
      {
        type: 'list',
        ordered: false,
        start: 1,
        items: [
          { task: true, checked: true, children: [{ type: 'paragraph', children: [{ type: 'text', text: 'done' }] }] },
          { task: false, checked: false, children: [{ type: 'paragraph', children: [{ type: 'text', text: 'todo' }] }] },
        ],
      },
      { type: 'code', lang: 'ts', text: 'let a = 1;' },
    ]);
  });

  it('handles unterminated fences while streaming, tables, entities and html', () => {
    expect(parseMarkdown('```py\nprint(1)')).toEqual([{ type: 'code', lang: 'py', text: 'print(1)' }]);
    const [table] = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(table).toEqual({
      type: 'table',
      header: [[{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b' }]],
      rows: [[[{ type: 'text', text: '1' }], [{ type: 'text', text: '2' }]]],
    });
    expect(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#x27;')).toBe("a & b <c> 'd'");
    const [p] = parseMarkdown('List<String> & more');
    expect(p.type === 'paragraph' && inlineText(p.children)).toBe('List<String> & more');
    expect(parseMarkdown('')).toEqual([]);
  });

  it('sizes table columns to their longest cell line from real font metrics', () => {
    const { padding, slack, minContent, maxContent, maxContentCap } = TABLE_CELL;
    const col = (content: number) => Math.ceil(content + padding + slack);
    // DM Sans Bold "Passed" is 49.3 pt at 14 pt, Regular "Passed" 46.5 pt; Menlo is 0.602 em.
    expect(textAdvance('Passed', 'bold', 14)).toBeCloseTo(49.29, 1);
    expect(textAdvance('Passed', 'regular', 14)).toBeCloseTo(46.48, 1);
    expect(textAdvance('abc', 'mono', 14.4)).toBeCloseTo(3 * 14.4 * (1233 / 2048), 5);

    const [table] = parseMarkdown(
      '| # | Passed | File | Notes |\n|---|---|---|---|\n| 1 | 14 | `src/remote/registry.ts` | throttle the periodic sessions.list fan-out to one per second |\n| 2 | 9 | x | short |',
    );
    if (table.type !== 'table') throw new Error('expected a table');
    const widths = tableColumnWidths(table.header, table.rows);
    // "#" pads up to the floor; the bold header sets "Passed" (so it never wraps); the code path
    // sets "File" in Menlo; the prose caps at the readable measure and wraps.
    expect(widths).toEqual([
      col(minContent),
      col(textAdvance('Passed', 'bold', 14)),
      col(textAdvance('src/remote/registry.ts', 'mono', 14.4)),
      col(maxContent),
    ]);
    // Dynamic Type widens every column; the measure stops at the cap.
    expect(tableColumnWidths(table.header, table.rows, 1.5)).toEqual([
      col(minContent * 1.5),
      col(textAdvance('Passed', 'bold', 14) * 1.5),
      col(Math.min(textAdvance('src/remote/registry.ts', 'mono', 14.4) * 1.5, maxContentCap)),
      col(maxContentCap),
    ]);
    // A <br> splits a cell into lines; ragged rows still get one width per column.
    const [br] = parseMarkdown('| a | b |\n|---|---|\n| ab<br>abcdefghijkl | x |\n| y |');
    if (br.type !== 'table') throw new Error('expected a table');
    expect(tableColumnWidths(br.header, br.rows)[0]).toBe(col(Math.max(minContent, textAdvance('abcdefghijkl', 'regular', 14))));
    expect(tableColumnWidths([[{ type: 'text', text: 'a' }]], [[[], [{ type: 'text', text: 'bbbbbbbbbbbb' }]]])).toEqual([
      col(minContent),
      col(textAdvance('bbbbbbbbbbbb', 'regular', 14)),
    ]);
  });
});

describe('notification target and session links', () => {
  it('reads hubId/sessionId from a raw APNs payload, data, or nested body', () => {
    expect(notificationTarget({ request: { content: { data: null }, trigger: { type: 'push', payload: { aps: {}, hubId: 'h', sessionId: 's' } } } })).toEqual({
      hubId: 'h',
      sessionId: 's',
    });
    expect(notificationTarget({ request: { content: { data: { hubId: 'h2', sessionId: 's2' } } } })).toEqual({ hubId: 'h2', sessionId: 's2' });
    expect(notificationTarget({ request: { content: { data: { body: '{"hubId":"h3","sessionId":"s3"}' } } } })).toEqual({
      hubId: 'h3',
      sessionId: 's3',
    });
    expect(notificationTarget({ request: { content: { data: {} } } })).toBeNull();
    expect(notificationTarget(null)).toBeNull();
  });

  it('parses session deep links', () => {
    expect(parseSessionLink('phiremote://session/hub%2F1/abc')).toEqual({ hubId: 'hub/1', sessionId: 'abc' });
    expect(parseSessionLink('/session/h/s')).toEqual({ hubId: 'h', sessionId: 's' });
    expect(parseSessionLink('phiremote://pair?x')).toBeNull();
  });
});

describe('speech', () => {
  it('turns markdown into speakable sentences (DESIGN.md §4b rules)', () => {
    const md =
      '# Done\n\nI fixed **two** bugs in `src/lib/app.ts`. See [the PR](https://github.com/x/y/pull/1) or https://www.example.com/a.\n\n```ts\nconst x = 1;\n```\n\n- first item\n- second item!\n\n1. numbered';
    expect(speakableText(md)).toBe(
      'Done. I fixed two bugs in app.ts. See the PR or link to example.com. Code block omitted. first item. second item! numbered.',
    );
    expect(speakableText('```sh\nls\n```')).toBe('The reply is a code block.');
    expect(speakableText('```sh\nls\n```\n\n```sh\npwd\n```\n\nThen run it.')).toBe('2 code blocks omitted. Then run it.');
    expect(speakableText('| k | v |\n|---|---|\n| a | 1 |')).toBe('k: a, v: 1.');
    expect(speakableText('| k |\n|---|\n| 1 |\n| 2 |\n| 3 |\n| 4 |')).toBe('Table omitted.');
  });

  it('reads paths as basenames, long code as "code", and arrows as "to"', () => {
    expect(speakableText('Edit /Users/me/ExampleCo/phi/src/main.ts and ~/notes/todo now.')).toBe('Edit main.ts and todo now.');
    expect(speakableText('Use `' + 'x'.repeat(41) + '` here.')).toBe('Use code here.');
    expect(speakableText('Map a -> b and c => d, then e → f.')).toBe('Map a to b and c to d, then e to f.');
    expect(speakableText('and/or 1/2 stays')).toBe('and/or 1/2 stays.');
    expect(speakableText('![diagram](https://x.dev/a.png) Look <b>here</b>.')).toBe('Look here.');
    expect(speakableText('> quoted *words*')).toBe('quoted words.');
  });

  it('chunks long text on sentence boundaries, never mid-word', () => {
    const s = 'One two three. '.repeat(100).trim();
    const chunks = chunkSpeech(s, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join(' ')).toBe(s);
    expect(chunks[0].endsWith('.')).toBe(true);
    const long = 'word '.repeat(50).trim();
    const parts = chunkSpeech(long, 32);
    expect(parts.every((c) => c.length <= 32 && !c.startsWith(' '))).toBe(true);
    expect(parts.join(' ')).toBe(long);
    expect(chunkSpeech('')).toEqual([]);
    expect(chunkSpeech('Short.')).toEqual(['Short.']);
  });

  const voices: VoiceLike[] = [
    { identifier: 'com.apple.speech.synthesis.voice.Bahh', name: 'Bahh', quality: 'Default', language: 'en-US' },
    { identifier: 'com.apple.voice.compact.en-US.Samantha', name: 'Samantha', quality: 'Default', language: 'en-US' },
    { identifier: 'com.apple.voice.enhanced.en-GB.Daniel', name: 'Daniel', quality: 'Enhanced', language: 'en-GB' },
    { identifier: 'com.apple.voice.enhanced.en-US.Evan', name: 'Evan', quality: 'Enhanced', language: 'en-US' },
    { identifier: 'com.apple.voice.premium.en-US.Zoe', name: 'Zoe', quality: 'Enhanced', language: 'en-US' },
    { identifier: 'com.apple.eloquence.en-US.Eddy', name: 'Eddy', quality: 'Default', language: 'en-US' },
  ];

  it('prefers premium, then enhanced, exact locale, and skips novelty voices', () => {
    expect(pickBestVoice(voices, 'en-US')?.name).toBe('Zoe');
    expect(pickBestVoice(voices.filter((v) => v.name !== 'Zoe'), 'en_US')?.name).toBe('Evan');
    expect(pickBestVoice(voices, 'en-AU')?.name).toBe('Zoe');
    expect(pickBestVoice(voices.slice(0, 2), 'en-US')?.name).toBe('Samantha');
    expect(pickBestVoice(voices, 'fr-FR')).toBeNull();
    expect(voiceLabel(voices[4])).toBe('Zoe (Premium)');
    expect(voiceLabel(voices[2])).toBe('Daniel (Enhanced)');
    expect(voiceQuality(voices[4])).toBe('Premium');
    expect(voiceQuality(voices[0])).toBe('Default');
  });
});

describe('storage', () => {
  it('escapes hub ids into valid SecureStore keys', () => {
    expect(hostStorageKey('abc-DEF.1')).toBe('phiremote.host.abc-DEF.1');
    expect(hostStorageKey('a/b_c')).toBe('phiremote.host.a_2f_b_5f_c');
    expect(hostStorageKey('a/b')).not.toBe(hostStorageKey('a_b'));
  });

  it('round-trips hosts and prefs, ignoring corrupt records', async () => {
    const kv = new MemoryKV();
    const s = new HostStorage(kv);
    const base = { name: 'n', urls: ['http://a:7717'], preferredUrl: 'http://a:7717', deviceId: 'd', token: 't', pairedAt: 1 };
    await Promise.all([s.save({ ...base, hubId: 'h1' }), s.save({ ...base, hubId: 'h2' })]);
    await kv.set(hostStorageKey('h2'), '{broken');
    expect((await s.loadAll()).map((h) => h.hubId)).toEqual(['h1']);
    await s.remove('h1');
    expect(await s.loadAll()).toEqual([]);
    expect(await s.loadPrefs()).toEqual({});
    await s.savePrefs({ notifications: 'off', speechRate: 1.15, voiceId: 'com.apple.voice.premium.en-US.Zoe', autoRead: true });
    expect(await s.loadPrefs()).toEqual({
      notifications: 'off',
      speechRate: 1.15,
      voiceId: 'com.apple.voice.premium.en-US.Zoe',
      autoRead: true,
    });
    await kv.set('phiremote.prefs.v1', JSON.stringify({ notifications: 'maybe', speechRate: 9 }));
    expect(await s.loadPrefs()).toEqual({});
  });

  it('round-trips the new-thread default and drops unusable parts', async () => {
    const kv = new MemoryKV();
    const s = new HostStorage(kv);
    const newThread = { model: { provider: 'anthropic', id: 'claude-opus-5-5', name: 'Claude Opus 5.5', reasoning: true }, thinkingLevel: 'high' };
    await s.savePrefs({ autoRead: true, newThread });
    expect(await s.loadPrefs()).toEqual({ autoRead: true, newThread });

    const raw = (newThread: unknown) => kv.set('phiremote.prefs.v1', JSON.stringify({ newThread }));
    await raw({ thinkingLevel: 'xhigh' });
    expect((await s.loadPrefs()).newThread).toEqual({ thinkingLevel: 'xhigh' });
    await raw({ model: { provider: 'openai', id: 'gpt-5.6' } });
    expect((await s.loadPrefs()).newThread).toEqual({ model: { provider: 'openai', id: 'gpt-5.6' } });
    await raw({ model: { provider: 'openai', id: 'gpt-5.6', name: 7, reasoning: 'yes' }, thinkingLevel: 'HIGH; rm' });
    expect((await s.loadPrefs()).newThread).toEqual({ model: { provider: 'openai', id: 'gpt-5.6' } });
    for (const bad of [null, 'opus', [], {}, { model: { id: 'x' } }, { model: { provider: '', id: 'x' } }, { thinkingLevel: '' }, { thinkingLevel: 3 }]) {
      await raw(bad);
      expect(await s.loadPrefs()).toEqual({});
    }
    expect(parseNewThreadDefault(undefined)).toBeUndefined();
  });
});

