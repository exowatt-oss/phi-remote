#!/usr/bin/env node
/**
 * Writes THIRD_PARTY_NOTICES.md (repo root) and src/generated/third-party-notices.ts (the
 * same text, shown in Settings › Open-source licenses):
 *   1. T3 Code's MIT notice (DESIGN.md §7) — UI design and code adapted from it;
 *   2. DM Sans, the embedded font, under the SIL Open Font License 1.1 (full text);
 *   3. the app's runtime npm dependencies with their versions and declared licenses;
 *   4. the runtime packages patched at install time (patches/, applied by patch-package);
 *   5. live dictation: the Phonon-2 model weights (CC-BY-4.0, downloaded at run time) and the
 *      phonon-coreml Swift code vendored in modules/phonon-stt (Apache-2.0, with its NOTICE);
 *   6. the dictation dictionary's English word list, from SCOWL (src/lib/dictionary/SCOWL-COPYRIGHT);
 *   7. read-aloud: the Kokoro-82M model, lexicon and G2P model (Apache-2.0, downloaded at run time) and the
 *      FluidAudio Swift code vendored in modules/kokoro-tts (Apache-2.0).
 * Run after changing dependencies: `npm run notices`.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readNotice = (file) => readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n').trim();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const T3 = `T3 Code (mobile app)
https://github.com/t3tools/t3code — apps/mobile
Portions of the user-interface design and component code in phi remote are adapted
from T3 Code, including its voice-input (dictation) engine: src/lib/voice-input/ and
src/services/voice-transcription*.ts are ported from T3 Code, and
patches/@react-native-ai+apple+0.12.0.patch and patches/expo-audio+58.0.10.patch
carry T3 Code's patches for those packages. The slash-command menu adapts T3 Code's
composer trigger detection, search ranking and command popover (src/lib/commands.ts,
src/components/composer/command-menu.tsx).

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const PHONON_WEIGHTS = `Phonon-2 Core ML — FermionResearch/Phonon-2-CoreML, revision 48af304c
https://huggingface.co/FermionResearch/Phonon-2-CoreML
Live dictation downloads these model weights on first use. They are Phonon-2 by Fermion
Research, derived from NVIDIA Parakeet TDT 0.6B v3 (nvidia/parakeet-tdt-0.6b-v3,
https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), (c) NVIDIA Corporation, both under the
Creative Commons Attribution 4.0 International licence (CC-BY-4.0,
https://creativecommons.org/licenses/by/4.0/). Changes by Fermion Research: the encoder's
linear weights were re-trained and quantised to a five-value palette, the other parameters
quantised to 6-bit tables, and the model converted to Core ML for the Apple Neural Engine.
phi remote uses the weights unmodified. The model's NOTICE follows.`;

const phononNotice = readNotice('modules/phonon-stt/MODEL-NOTICE');
const phononCodeNotice = readNotice('modules/phonon-stt/ios/PhononCoreML/NOTICE');
const apache = readNotice('modules/phonon-stt/ios/PhononCoreML/LICENSE');

const scowl = readNotice('src/lib/dictionary/SCOWL-COPYRIGHT');
const kokoroNotice = readNotice('modules/kokoro-tts/MODEL-NOTICE');

const ofl = readNotice('node_modules/@expo-google-fonts/dm-sans/LICENSE_FONT');

const deps = Object.keys(pkg.dependencies ?? {})
  .sort()
  .map((name) => {
    const meta = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'));
    const license = typeof meta.license === 'string' ? meta.license : (meta.license?.type ?? 'see package');
    return `- ${name} ${meta.version} — ${license}`;
  })
  .join('\n');

// Why each patch exists (shown in the notices next to the package it modifies).
const PATCH_NOTES = {
  '@react-native-ai/apple':
    "T3 Code's fix: transcription waits for every SpeechTranscriber segment before resolving, prepare returns the resolved locale and reports unsupported locales, temporary files are always removed; phi remote: transcription takes contextual strings (the dictation dictionary) for SpeechAnalyzer",
  'expo-audio': "T3 Code's fix: a recording that fails is reported as an error instead of a finished recording",
};

const patched = readdirSync(join(root, 'patches'))
  .filter((f) => f.endsWith('.patch'))
  .sort()
  .map((file) => {
    // patch-package names: <scope>+<name>+<version>.patch (scope optional)
    const parts = file.replace(/\.patch$/, '').split('+');
    const version = parts.pop();
    const name = parts.join('/');
    const note = PATCH_NOTES[name] ?? 'patched';
    return `- ${name} ${version} — modified by patches/${file}: ${note}.`;
  })
  .join('\n');

const text = `# Third-party notices

phi remote includes or adapts the following third-party material.

## T3 Code

\`\`\`text
${T3}
\`\`\`

## DM Sans (embedded font)

Shipped from @expo-google-fonts/dm-sans.

\`\`\`text
${ofl}
\`\`\`

## Phonon-2 (live dictation model)

\`\`\`text
${PHONON_WEIGHTS}

${phononNotice}
\`\`\`

## phonon-coreml (live dictation code)

The Swift sources and prebuilt decoder in modules/phonon-stt/ios (PhononCoreML/,
PhononTDT.xcframework) are vendored from phonon-coreml by Fermion Research, under the Apache
License 2.0. For the greedy-TDT decoder, only the prebuilt binary is distributed (no decoder C source at the pinned revision); one availability annotation was added (modules/phonon-stt/ios/PhononCoreML/VENDORED.md).

\`\`\`text
${phononCodeNotice}

${apache}
\`\`\`

## Kokoro-82M and FluidAudio (read-aloud voice)

The natural read-aloud voice downloads the Kokoro-82M Core ML model on first use. The Swift sources
in modules/kokoro-tts/ios/FluidKokoro are vendored from FluidAudio by FluidInference, under the
Apache License 2.0 (full text above); the changes are listed in
modules/kokoro-tts/ios/FluidKokoro/VENDORED.md.

\`\`\`text
${kokoroNotice}
\`\`\`

## SCOWL (dictation dictionary word list)

The common English words dictation corrections leave alone (src/generated/common-words.ts) are
derived from SCOWL (Spell Checker Oriented Word Lists), release 2020.12.07,
http://wordlist.aspell.net — words, capitalized words and proper names up to size 50.

\`\`\`text
${scowl}
\`\`\`

## Runtime packages

Each package keeps its own license, found in its folder under node_modules.

${deps}

## Modified packages

These runtime packages are patched at install time (\`patch-package\`, see \`patches/\`); the
modifications are under the same license as the package.

${patched}
`;

writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), text);
const out = join(root, 'src/generated/third-party-notices.ts');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `// Generated by scripts/generate-notices.mjs from THIRD_PARTY_NOTICES.md. Do not edit.\n\nexport const THIRD_PARTY_NOTICES = ${JSON.stringify(text)};\n`,
);
console.log(`wrote THIRD_PARTY_NOTICES.md and src/generated/third-party-notices.ts (${text.length} chars)`);
