import { EMPTY_DICTIONARY_FILE, parseDictionaryFile, parseHeardAs, removeWord, serializeDictionaryFile, upsertWord, WORDS_MAX } from '../store';

describe('dictionary file', () => {
  it('round-trips your words and each computer’s vocabulary', () => {
    const file = {
      version: 1 as const,
      words: [{ text: 'Jev', heardAs: ['Jeff', 'chev'] }],
      hubs: {
        'hub-1': {
          name: 'MY-MAC',
          commands: [{ name: 'skill:jev-mobile', source: 'skill' as const }],
          models: ['Example Fast'],
          folders: ['phi-remote'],
          updatedAt: 42,
        },
      },
    };
    expect(parseDictionaryFile(serializeDictionaryFile(file))).toEqual(file);
  });

  it('reads nothing, garbage and partial data without throwing', () => {
    expect(parseDictionaryFile(null)).toEqual(EMPTY_DICTIONARY_FILE);
    expect(parseDictionaryFile('not json')).toEqual(EMPTY_DICTIONARY_FILE);
    expect(parseDictionaryFile('[]')).toEqual(EMPTY_DICTIONARY_FILE);
    const parsed = parseDictionaryFile(
      JSON.stringify({
        words: [{ text: '  ExampleCo  ', heardAs: ['example sea', 3, '', 'EXAMPLE SEA'] }, { text: '' }, null, { heardAs: ['x'] }, { text: 'ExampleCo', heardAs: ['example co'] }],
        hubs: { a: { name: 'mac', commands: [{ name: 'new', source: 'builtin' }, { name: 'x', source: 'nope' }, 'bad'], models: [1, 'Kimi'], folders: 'no' }, b: 'bad' },
      }),
    );
    expect(parsed.words).toEqual([{ text: 'ExampleCo', heardAs: ['example sea', 'example co'] }]);
    expect(parsed.hubs).toEqual({ a: { name: 'mac', commands: [{ name: 'new', source: 'builtin' }], models: ['Kimi'], folders: [], updatedAt: 0 } });
  });
});

describe('editing your words', () => {
  it('splits "heard as" on commas and new lines, dropping blanks and repeats', () => {
    expect(parseHeardAs(' chaff, fi ,, fee\nFI ,  exo   what ')).toEqual(['chaff', 'fi', 'fee', 'exo what']);
    expect(parseHeardAs('')).toEqual([]);
  });

  it('adds words sorted, replaces the same word whatever its case, and renames', () => {
    let words = upsertWord([], { text: 'phi', heardAs: ['chaff', 'phi'] });
    words = upsertWord(words, { text: ' ExampleCo ', heardAs: ['example sea'] });
    expect(words).toEqual([
      { text: 'ExampleCo', heardAs: ['example sea'] },
      { text: 'phi', heardAs: ['chaff'] },
    ]);
    words = upsertWord(words, { text: 'ExampleCo', heardAs: [] });
    expect(words.map((w) => w.text)).toEqual(['ExampleCo', 'phi']);
    words = upsertWord(words, { text: 'ExampleCo Labs', heardAs: ['example labs'] }, 'ExampleCo');
    expect(words).toEqual([
      { text: 'ExampleCo Labs', heardAs: ['example labs'] },
      { text: 'phi', heardAs: ['chaff'] },
    ]);
    expect(upsertWord(words, { text: '   ', heardAs: [] })).toBe(words);
    expect(removeWord(words, 'PHI')).toEqual([{ text: 'ExampleCo Labs', heardAs: ['example labs'] }]);
  });

  it('keeps at most WORDS_MAX words', () => {
    let words: { text: string; heardAs: string[] }[] = [];
    for (let i = 0; i < WORDS_MAX + 5; i += 1) words.push({ text: `w${String(i).padStart(4, '0')}`, heardAs: [] });
    words = upsertWord(words, { text: 'a', heardAs: [] });
    expect(words).toHaveLength(WORDS_MAX);
  });
});
