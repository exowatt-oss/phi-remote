// Synthetic phrases only: the original corpus was dictated by an employee and is not exported.
import { correctDictation, correctDictationDetailed } from '../correct';
import { compileDictionary } from '../vocabulary';

const dict = compileDictionary({ words: [{ text: 'DemoProject', heardAs: ['demo project'] }], hubs: [] });
const fix = (heard: string) => correctDictation(heard, dict);

it('corrects built-in phi terms and user-defined names', () => {
  expect(fix('the fire remote app')).toBe('the phi remote app');
  expect(fix('ship the demo project')).toBe('ship the DemoProject');
});

it('leaves ordinary language untouched and records corrections', () => {
  expect(fix('Please update the documentation.')).toBe('Please update the documentation.');
  const result = correctDictationDetailed('open demo project', dict);
  expect(result.text).toBe('open DemoProject');
  expect(result.corrections.length).toBeGreaterThan(0);
});
