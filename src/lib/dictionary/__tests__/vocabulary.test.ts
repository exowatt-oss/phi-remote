import { compileDictionary, folderNames, mergeHubVocabulary, modelDisplayName, SEED } from '../vocabulary';
import { FIXTURE_HUBS } from '../__fixtures__/vocabulary';

it('seeds generic terms without company names', () => {
  const dict = compileDictionary({ words: [{ text: 'ExampleTerm', heardAs: ['example term'] }], hubs: FIXTURE_HUBS });
  expect(SEED.map((w) => w.text)).toContain('phi');
  expect(dict.terms.get('exampleterm')).toMatchObject({ source: 'user', text: 'ExampleTerm' });
  expect(dict.terms.get('deepseek')).toMatchObject({ source: 'seed' });
  expect(dict.aliases.get('fire')?.map((r) => r.text)).toEqual(['phi mobile app', 'phi remote']);
  expect(dict.contextualStrings[0]).toBe('ExampleTerm');
  expect(dict.counts).toMatchObject({ user: 1, seed: SEED.length, host: 2 });
});

it('parses model and host vocabulary without leaking home folder names', () => {
  expect(modelDisplayName({ id: 'a', name: 'GPT Example (provider note)' })).toBe('GPT Example');
  expect(folderNames(['/Users/alex', '/Users/alex/projects/phi-remote', '/home/alex/test-project', '/srv/x'])).toEqual(['phi-remote', 'test-project']);
  const merged = mergeHubVocabulary(undefined, { name: 'my-mac', models: [{ id: 'a', name: 'GPT Example (provider note)' }], folders: ['/Users/alex/projects/phi-remote'] }, 10);
  expect(merged).toMatchObject({ name: 'my-mac', models: ['GPT Example'], folders: ['phi-remote'], updatedAt: 10 });
});
