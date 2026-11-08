// Synthetic command, model and folder vocabulary for offline dictionary tests.
import type { CommandSource } from '@/lib/protocol';
import type { HubVocabulary } from '../vocabulary';

export const FIXTURE_COMMANDS: { name: string; source: CommandSource }[] = [
  { name: 'new', source: 'builtin' },
  { name: 'model', source: 'builtin' },
  { name: 'skill:format-code', source: 'skill' },
  { name: 'skill:checkin', source: 'skill' },
  { name: 'checkin', source: 'prompt' },
  { name: 'mcp', source: 'extension' },
];
export const FIXTURE_MODELS = ['Claude Sonnet', 'GPT Example', 'DeepSeek V3'];
export const FIXTURE_FOLDERS = ['phi', 'phi-remote', 'example-api', 'docs'];
export const FIXTURE_HUBS: HubVocabulary[] = [
  { name: 'my-mac', commands: FIXTURE_COMMANDS, models: FIXTURE_MODELS, folders: FIXTURE_FOLDERS, updatedAt: 1 },
  { name: 'laptop-test', commands: FIXTURE_COMMANDS, models: FIXTURE_MODELS, folders: ['phi'], updatedAt: 1 },
];
