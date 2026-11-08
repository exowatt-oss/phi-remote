import {
  caretAfterEdit,
  commandLabel,
  commandNames,
  completeOnInsert,
  detectSlashTrigger,
  exactCommandMatch,
  highlightSegments,
  insertCommand,
  menuListHeight,
  rankCommands,
  scoreQueryMatch,
  splitLeadingCommand,
  SOURCE_TAG,
} from '../commands';
import type { CommandInfo } from '../protocol';

const at = (text: string, caret = text.length) => detectSlashTrigger(text, { start: caret, end: caret });

const COMMANDS: CommandInfo[] = [
  { name: 'compact', source: 'builtin', description: 'Compact the session context', argumentHint: '[instructions]' },
  { name: 'model', source: 'builtin', description: "Switch this session's model", argumentHint: '<provider/model>' },
  { name: 'name', source: 'builtin', description: 'Set the session display name', argumentHint: '<name>' },
  { name: 'new', source: 'builtin', description: 'Start a new session' },
  { name: 'thinking', source: 'builtin', description: 'Set the thinking level', argumentHint: '<level>' },
  { name: 'mcp', source: 'extension', description: 'Show MCP server status' },
  { name: 'skill:checkin', source: 'skill', description: 'Give a concise status check-in on the current session' },
  { name: 'skill:make-plan', source: 'skill', description: 'Create an execution-ready implementation plan' },
  { name: 'skill:orchestrate', source: 'skill', description: 'Pure-orchestrator mode for executing an existing plan' },
  { name: 'skill:use-subs', source: 'skill', description: 'Mixed subagent swarm: route each task to the right worker' },
  { name: 'skill:web-design', source: 'skill', description: 'End-to-end web UI design and validation' },
  { name: 'checkin', source: 'prompt', description: 'Get a concise, useful update on the current work' },
  { name: 'make-report', source: 'prompt', description: 'Create a polished HTML report', argumentHint: '[topic]' },
];
const byName = (name: string) => COMMANDS.find((c) => c.name === name)!;
const names = (list: CommandInfo[]) => list.map((c) => c.name);

describe('labels', () => {
  it('drops the skill: prefix for skills only', () => {
    expect(commandLabel(byName('skill:use-subs'))).toBe('use-subs');
    expect(commandLabel({ name: 'skill:', source: 'skill' })).toBe('skill:');
    expect(commandLabel({ name: 'skill:x', source: 'extension' })).toBe('skill:x');
    expect(commandLabel(byName('new'))).toBe('new');
  });

  it('tags sources as Command / Skill / Prompt', () => {
    expect(SOURCE_TAG.builtin).toBe('Command');
    expect(SOURCE_TAG.extension).toBe('Command');
    expect(SOURCE_TAG.skill).toBe('Skill');
    expect(SOURCE_TAG.prompt).toBe('Prompt');
  });
});

describe('detectSlashTrigger', () => {
  it('fires on a slash at the start of the draft', () => {
    expect(at('/')).toEqual({ query: '', rangeStart: 0, rangeEnd: 1, tokenEnd: 1, atMessageStart: true });
    expect(at('/us')).toMatchObject({ query: 'us', rangeStart: 0, rangeEnd: 3, atMessageStart: true });
  });

  it('fires at the start of a line and after whitespace', () => {
    expect(at('hello\n/co')).toMatchObject({ query: 'co', rangeStart: 6, atMessageStart: false });
    expect(at('please run /chec')).toMatchObject({ query: 'chec', rangeStart: 11, atMessageStart: false });
    expect(at('  /new')).toMatchObject({ query: 'new', rangeStart: 2, atMessageStart: true });
  });

  it('ignores slashes inside words, paths, selections and finished tokens', () => {
    expect(at('a/b')).toBeNull();
    expect(at('/tmp/build.sh')).toBeNull();
    expect(at('/tmp/', 3)).toBeNull(); // the whole word counts, not just the part before the caret
    expect(at('//')).toBeNull();
    expect(at('/new ')).toBeNull();
    expect(at('plain text')).toBeNull();
    expect(detectSlashTrigger('/new', { start: 1, end: 3 })).toBeNull();
  });

  it('reports the whole token when the caret is inside it', () => {
    expect(at('/use-subs rest', 4)).toEqual({ query: 'use', rangeStart: 0, rangeEnd: 4, tokenEnd: 9, atMessageStart: true });
  });

  it('clamps a stale caret', () => {
    expect(at('/ne', 99)).toMatchObject({ query: 'ne', rangeEnd: 3 });
  });
});

describe('rankCommands', () => {
  it('empty query: built-ins, then skills, prompts, extension commands, in the hub order', () => {
    expect(names(rankCommands(COMMANDS, ''))).toEqual([
      'compact',
      'model',
      'name',
      'new',
      'thinking',
      'skill:checkin',
      'skill:make-plan',
      'skill:orchestrate',
      'skill:use-subs',
      'skill:web-design',
      'checkin',
      'make-report',
      'mcp',
    ]);
  });

  it('matches skills by their short name', () => {
    expect(names(rankCommands(COMMANDS, 'us'))[0]).toBe('skill:use-subs');
    expect(names(rankCommands(COMMANDS, 'use'))[0]).toBe('skill:use-subs');
    expect(names(rankCommands(COMMANDS, 'orch'))).toEqual(['skill:orchestrate']);
  });

  it('ranks exact, then prefix, then boundary, then substring, then fuzzy', () => {
    expect(names(rankCommands(COMMANDS, 'new'))[0]).toBe('new');
    expect(names(rankCommands(COMMANDS, 'n')).slice(0, 2)).toEqual(['new', 'name']); // shorter prefix match first
    // `plan` is a word inside make-plan (boundary) and nothing starts with it
    expect(names(rankCommands(COMMANDS, 'plan'))[0]).toBe('skill:make-plan');
    // fuzzy: w…d…s matches web-design only
    expect(names(rankCommands(COMMANDS, 'wds'))).toEqual(['skill:web-design']);
  });

  it('puts a skill and a prompt of the same name together, built-in/skill first', () => {
    expect(names(rankCommands(COMMANDS, 'checkin'))).toEqual(['skill:checkin', 'checkin']);
  });

  it('accepts the full skill: name and a leading slash', () => {
    expect(names(rankCommands(COMMANDS, 'skill:use'))[0]).toBe('skill:use-subs');
    expect(names(rankCommands(COMMANDS, 'skill')).every((n) => n.startsWith('skill:'))).toBe(true);
    expect(names(rankCommands(COMMANDS, '/new'))[0]).toBe('new');
  });

  it('searches descriptions only from three characters, below every name match', () => {
    expect(names(rankCommands(COMMANDS, 'sw'))).not.toContain('skill:use-subs'); // "swarm" needs 3+
    const swarm = names(rankCommands(COMMANDS, 'swarm'));
    expect(swarm).toEqual(['skill:use-subs']);
    const ses = names(rankCommands(COMMANDS, 'session'));
    expect(ses.length).toBeGreaterThan(1);
  });

  it('returns nothing when nothing matches and honours the limit', () => {
    expect(rankCommands(COMMANDS, 'zzz')).toEqual([]);
    expect(rankCommands(COMMANDS, '', 3)).toHaveLength(3);
    expect(rankCommands(COMMANDS, 'e', 2)).toHaveLength(2);
  });
});

describe('scoreQueryMatch', () => {
  it('orders the match kinds', () => {
    const score = (value: string, query: string) =>
      scoreQueryMatch({ value, query, exactBase: 0, prefixBase: 2, boundaryBase: 4, includesBase: 6, fuzzyBase: 100 });
    expect(score('new', 'new')).toBe(0);
    expect(score('newer', 'new')!).toBeLessThan(score('a-new', 'new')!);
    expect(score('a-new', 'new')!).toBeLessThan(score('aanew', 'new')!); // boundary beats substring at the same spot
    expect(score('aanew', 'new')!).toBeLessThan(score('n-e-w', 'new')!);
    expect(score('xyz', 'new')).toBeNull();
    expect(score('', 'x')).toBeNull();
  });
});

describe('exactCommandMatch', () => {
  it('prefers a full name over a short label', () => {
    expect(exactCommandMatch(COMMANDS, 'checkin')?.name).toBe('checkin'); // the prompt, not skill:checkin
    expect(exactCommandMatch(COMMANDS, 'use-subs')?.name).toBe('skill:use-subs');
    expect(exactCommandMatch(COMMANDS, 'NEW')?.name).toBe('new');
  });

  it('is null for partial or empty queries', () => {
    expect(exactCommandMatch(COMMANDS, 'use')).toBeNull();
    expect(exactCommandMatch(COMMANDS, '')).toBeNull();
  });
});

describe('insertCommand', () => {
  it('replaces the token with the full name and a trailing space', () => {
    const text = '/us';
    expect(insertCommand(text, at(text)!, byName('skill:use-subs'))).toEqual({ text: '/skill:use-subs ', caret: 16 });
  });

  it('replaces the whole token when the caret is inside it, keeping one space', () => {
    const text = '/usXX do it';
    expect(insertCommand(text, at(text, 3)!, byName('skill:use-subs'))).toEqual({ text: '/skill:use-subs do it', caret: 16 });
  });

  it('works mid-draft and before a newline', () => {
    const text = 'first\n/co\nsecond';
    expect(insertCommand(text, at(text, 9)!, byName('compact'))).toEqual({ text: 'first\n/compact \nsecond', caret: 15 });
    const mid = 'run /ma now';
    expect(insertCommand(mid, at(mid, 7)!, byName('make-report'))).toEqual({ text: 'run /make-report now', caret: 17 });
  });
});

describe('completeOnInsert', () => {
  it('space after a short skill label completes to the full name', () => {
    expect(completeOnInsert('/use-subs', '/use-subs ', COMMANDS)).toEqual({ text: '/skill:use-subs ', caret: 16 });
  });

  it('Return after an exact name completes instead of a newline', () => {
    expect(completeOnInsert('/new', '/new\n', COMMANDS)).toEqual({ text: '/new ', caret: 5 });
  });

  it('leaves everything else alone', () => {
    expect(completeOnInsert('/new', '/new ', COMMANDS)).toBeNull(); // already complete
    expect(completeOnInsert('/us', '/us ', COMMANDS)).toBeNull(); // not exact
    expect(completeOnInsert('/new', '/newx', COMMANDS)).toBeNull(); // not space/Return
    expect(completeOnInsert('/new', '/new  ', COMMANDS)).toBeNull(); // not one character
    expect(completeOnInsert('hello', 'hello ', COMMANDS)).toBeNull();
    expect(completeOnInsert('/use-subs', '/use-subs ', [])).toBeNull();
    // a space typed in the middle of the token is not a completion
    expect(completeOnInsert('/use-subs', '/use -subs', COMMANDS)).toBeNull();
  });

  it('completes a token later in the draft', () => {
    expect(completeOnInsert('hi\n/use-subs', 'hi\n/use-subs\n', COMMANDS)).toEqual({ text: 'hi\n/skill:use-subs ', caret: 19 });
  });
});

describe('caretAfterEdit', () => {
  it('follows typing, deleting, pasting and replacing', () => {
    expect(caretAfterEdit('/u', '/us')).toBe(3);
    expect(caretAfterEdit('/us', '/u')).toBe(2);
    expect(caretAfterEdit('ab', 'aXYZb')).toBe(4);
    expect(caretAfterEdit('teh', 'the ')).toBe(4);
    expect(caretAfterEdit('aaa', 'aaaa')).toBe(4);
  });
});

describe('highlighting', () => {
  const known = commandNames(COMMANDS);

  it('knows full names and unambiguous skill labels', () => {
    expect(known.has('skill:use-subs')).toBe(true);
    expect(known.has('use-subs')).toBe(true);
    expect(known.has('checkin')).toBe(true); // the prompt
    expect(known.has('nope')).toBe(false);
  });

  it('marks known commands at the start of a line only', () => {
    expect(highlightSegments('/skill:use-subs do the plan', known)).toEqual([
      { text: '/skill:use-subs', command: true },
      { text: ' do the plan', command: false },
    ]);
    expect(highlightSegments('intro\n  /new\nrun /compact', known)).toEqual([
      { text: 'intro\n  ', command: false },
      { text: '/new', command: true },
      { text: '\nrun /compact', command: false },
    ]);
  });

  it('leaves unknown tokens, partial tokens and paths plain', () => {
    expect(highlightSegments('/us', known)).toEqual([{ text: '/us', command: false }]);
    expect(highlightSegments('/new/x', known)).toEqual([{ text: '/new/x', command: false }]);
    expect(highlightSegments('/newer', known)).toEqual([{ text: '/newer', command: false }]);
    expect(highlightSegments('', known)).toEqual([]);
    expect(highlightSegments('/new', new Set())).toEqual([{ text: '/new', command: false }]);
  });

  it('round-trips the text', () => {
    const text = '/compact focus\n/new\n/x /y\n/use-subs';
    expect(highlightSegments(text, known).map((s) => s.text).join('')).toBe(text);
  });
});

describe('splitLeadingCommand', () => {
  it('splits a leading command from its arguments', () => {
    expect(splitLeadingCommand('/skill:use-subs implement the plan')).toEqual({ name: 'skill:use-subs', label: 'use-subs', rest: 'implement the plan' });
    expect(splitLeadingCommand('/new')).toEqual({ name: 'new', label: 'new', rest: '' });
    expect(splitLeadingCommand('/compact\n\nfocus on the API')).toEqual({ name: 'compact', label: 'compact', rest: 'focus on the API' });
  });

  it('reads phi’s expanded skill block as the command it came from', () => {
    const block = '<skill name="use-subs" location="/Users/f/.pi/agent/skills/use-subs/SKILL.md">\nReferences are relative to /x.\n\n# Use subs\n</skill>';
    expect(splitLeadingCommand(`${block}\n\nship it`)).toEqual({ name: 'skill:use-subs', label: 'use-subs', rest: 'ship it' });
    expect(splitLeadingCommand(block)).toEqual({ name: 'skill:use-subs', label: 'use-subs', rest: '' });
    // head/tail-truncated block without its closing tag
    expect(splitLeadingCommand('<skill name="x" location="/l">\nbody … [99 chars omitted] …')).toEqual({ name: 'skill:x', label: 'x', rest: '' });
  });

  it('is null for paths, prose and odd tokens', () => {
    expect(splitLeadingCommand('/tmp/build.sh fails')).toBeNull();
    expect(splitLeadingCommand('see /new')).toBeNull();
    expect(splitLeadingCommand('/ hi')).toBeNull();
    expect(splitLeadingCommand('/-x')).toBeNull();
    expect(splitLeadingCommand('')).toBeNull();
  });
});

describe('menuListHeight', () => {
  it('shows whole rows plus a half, up to 5.5, within the room', () => {
    expect(menuListHeight(1000, 13, 54, 4)).toBe(301); // 5.5 rows
    expect(menuListHeight(183, 13, 54, 4)).toBe(139); // SE with the keyboard: 2.5 rows, not 3.3
    expect(menuListHeight(240, 13, 54, 4)).toBeLessThanOrEqual(240);
    expect(menuListHeight(240, 13, 54, 4)).toBe(193); // 3.5 rows
  });

  it('never cuts a short list and keeps one row when there is no room', () => {
    expect(menuListHeight(1000, 2, 54, 4)).toBe(116);
    expect(menuListHeight(20, 13, 54, 4)).toBe(58);
  });
});
