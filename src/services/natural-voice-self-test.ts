/**
 * Natural-voice self-test (Simulator / QA only). Inert unless the app is launched with
 *
 *   -phiTtsSelfTest 1             run it (downloads the model first if it is not on the phone)
 *   -phiTtsCellular 1             allow the download on an expensive network (default: Wi-Fi rules)
 *   -phiTtsPlay 0                 skip the live playback check (default: plays the reply, stops after two pieces)
 *   -phiTtsUnits cpu              load with these compute units (ane | gpu | cpu; default ane)
 *
 * Writes Documents/tts-selftest/: sample-<voice>.wav (the Settings sample sentence) and reply-<voice>.wav (a typical reply,
 * prepared and split exactly as read-aloud does) for every natural voice, the same two with the system voice
 * (system-sample.wav, system-reply.wav), and tts-selftest.json with download / load / per-piece synthesis timings and the
 * live playback check (time to the first audio scheduled, stop). Logs one line per step ([tts-selftest]).
 * Called from bootstrap.ts; inert in TestFlight / App Store installs (no launch arguments there).
 */
import { Directory, File, Paths } from 'expo-file-system';
import { Platform, Settings } from 'react-native';

import KokoroTts from '../../modules/kokoro-tts';
import { speakableText } from '@/lib/speech';
import { readPieces } from '@/lib/tts/reader';
import { PRONUNCIATIONS, speechPieces, spokenForm } from '@/lib/tts/spoken';
import { NATURAL_VOICES } from '@/lib/tts/voices';

function arg(key: string): string | null {
  if (Platform.OS !== 'ios') return null;
  try {
    const v = Settings.get(key);
    return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null;
  } catch {
    return null;
  }
}
const log = (s: string) => console.log(`[tts-selftest] ${s}`);

/** What Settings plays for each voice (the bundled assets/voice-samples clips are this sentence). */
export const SAMPLE_SENTENCE = 'This is how phi reads replies aloud.';

/** A typical reply: markdown, a path, units, a version, a code block. */
export const SAMPLE_REPLY = [
  'I fixed the reconnect bug in phi remote. The socket now waits 2 s before it retries, and all 42 tests pass, about 12% faster than before.',
  'I also cleaned up `src/services/remote.ts` and bumped the app to v0.18.2.',
  '```ts\nconst retryMs = 2000;\n```',
  'Want me to push it to main and cut a TestFlight build?',
].join('\n\n');

let ran = false;
export async function runNaturalVoiceSelfTestIfRequested(): Promise<void> {
  const tts = KokoroTts;
  if (arg('phiTtsSelfTest') !== '1' || ran || !tts) return;
  ran = true;
  const dir = new Directory(Paths.document, 'tts-selftest');
  try {
    if (!dir.exists) dir.create();
  } catch {}
  const path = (name: string) => new File(dir, name).uri;
  const out: Record<string, unknown> = { available: tts.isAvailable(), status: tts.getModelStatus(), at: new Date().toISOString() };
  const save = () => {
    try {
      new File(dir, 'tts-selftest.json').write(JSON.stringify(out, null, 1));
    } catch (e) {
      log(`write failed ${String(e)}`);
    }
  };
  let lastPct = -1;
  const sub = tts.addListener('onProgress', (e) => {
    const pct = Math.floor(e.fraction * 100);
    if (e.phase === 'compiling' || pct >= lastPct + 10) {
      lastPct = pct;
      log(`progress ${e.phase} ${pct}%`);
    }
  });
  try {
    const reply = spokenForm(speakableText(SAMPLE_REPLY));
    const pieces = speechPieces(reply, 1);
    out.reply = { text: reply, pieces };
    const system = await tts.writeSystemWav(reply, { rate: 1 }, path('system-reply.wav'));
    await tts.writeSystemWav(SAMPLE_SENTENCE, { rate: 1 }, path('system-sample.wav'));
    out.system = system;
    log(`system voice ${system.voiceName} (${system.voice}): ${system.seconds.toFixed(2)} s`);
    if (!tts.getModelStatus().ready) {
      const t = Date.now();
      const r = await tts.downloadModel({ allowCellular: arg('phiTtsCellular') === '1' });
      out.download = { ...r, wallMs: Date.now() - t, status: tts.getModelStatus() };
      log(`download ${JSON.stringify(out.download)}`);
      save();
    }
    const t = Date.now();
    const units = arg('phiTtsUnits');
    out.load = {
      ...(await tts.load({ lexicon: { ...PRONUNCIATIONS }, units: units === 'gpu' || units === 'cpu' ? units : 'ane', timeoutMs: 300_000 })),
      wallMs: Date.now() - t,
      footprintMB: tts.footprintMB(),
    };
    log(`load ${JSON.stringify(out.load)}`);
    save();
    const voices: Record<string, unknown> = {};
    out.voices = voices;
    for (const v of NATURAL_VOICES) {
      const sample = await tts.writeWav([SAMPLE_SENTENCE], { voice: v.id }, path(`sample-${v.id}.wav`));
      const r = await tts.writeWav(
        pieces.map((p) => p.text),
        { voice: v.id, speed: 1, pauses: pieces.map((p) => p.pause) },
        path(`reply-${v.id}.wav`),
      );
      const synthMs = r.pieces.reduce((a, p) => a + p.synthMs, 0);
      const audio = r.pieces.reduce((a, p) => a + p.audioSeconds, 0);
      voices[v.id] = { sample, reply: r, firstPieceMs: r.pieces[0]?.synthMs, rtf: synthMs / 1000 / audio };
      log(
        `${v.id}: sample ${sample.seconds.toFixed(2)} s (${sample.pieces.map((p) => `${p.frames}f peak ${(p.peak ?? 0).toFixed(3)}`).join()}), reply ${r.seconds.toFixed(2)} s, first piece ${r.pieces[0]?.synthMs.toFixed(0)} ms, ` +
          `RTF ${(synthMs / 1000 / audio).toFixed(3)} (${r.pieces.map((p) => `${p.synthMs.toFixed(0)}ms/${p.audioSeconds.toFixed(1)}s${p.fast ? '' : '*'}`).join(' ')})`,
      );
      save();
    }
    if (arg('phiTtsPlay') !== '0') {
      // The live path: synthesize + play with the reader, as read-aloud does; stop after two pieces were heard.
      const t0 = Date.now();
      let firstScheduled = 0;
      let heard = 0;
      let stopped = false;
      const result = await readPieces(pieces, {
        synthesize: (p) => tts.synthesize(p.text, { voice: 'af_heart', speed: 1, pause: p.pause }),
        play: (id) => {
          if (!firstScheduled) firstScheduled = Date.now() - t0;
          return tts.play(id).then((ok) => {
            if (ok && ++heard >= 2 && !stopped) {
              stopped = true;
              tts.stop();
            }
            return ok;
          });
        },
        cancelled: () => stopped,
      });
      out.playback = { outcome: result.outcome, next: result.next, firstAudioMs: firstScheduled, heard, wallMs: Date.now() - t0 };
      log(`playback ${JSON.stringify(out.playback)}`);
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    log(`error ${String(out.error)}`);
  }
  sub.remove();
  out.done = true;
  save();
  log('done');
}
