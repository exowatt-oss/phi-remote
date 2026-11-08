/**
 * Phonon-2 live-dictation self-test (Simulator / QA only). Inert unless the app is launched with
 *
 *   -phiPhononModel <dir | "download">   the Phonon-2-CoreML folder (absolute path or a name in Documents), or
 *                                         "download" to run the first-use download from Hugging Face
 *   -phiPhononFiles <a.wav,b.wav,...>     audio files (absolute paths or names in Documents)
 *   -phiPhononSpeed <x>                   live feed speed (default 1 = real time)
 *   -phiPhononUnits <ane|cpu|gpu>         compute units (default ane; the Simulator has no Neural Engine)
 *
 * For each file: transcribeFile (offline) and startFile (the live loop the microphone path uses, fed in 100 ms chunks), every
 * partial collected. Writes Documents/phonon-selftest.json and logs one line per step.
 * Called from bootstrap.ts beside runDictationSelfTestIfRequested(); inert in TestFlight / App Store installs.
 */
import { File, Paths } from 'expo-file-system';
import { Platform, Settings } from 'react-native';

import PhononStt, { type PhononFinal, type PhononPartial } from '../../modules/phonon-stt';

function arg(key: string): string | null {
  if (Platform.OS !== 'ios') return null;
  try {
    const v = Settings.get(key);
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}
const abs = (p: string) => (p.startsWith('/') ? p : new File(Paths.document, p).uri.replace('file://', ''));
const log = (s: string) => console.log(`[phonon-selftest] ${s}`);

let ran = false;
export async function runPhononSelfTestIfRequested(): Promise<void> {
  const model = arg('phiPhononModel');
  const stt = PhononStt;
  if (!model || ran || !stt) return;
  ran = true;
  const files = (arg('phiPhononFiles') ?? '').split(',').filter(Boolean);
  const speed = Number(arg('phiPhononSpeed') ?? '1') || 1;
  const units = (arg('phiPhononUnits') ?? 'ane') as 'ane' | 'cpu' | 'gpu';
  const out: Record<string, unknown> = { available: stt.isAvailable(), status: stt.getModelStatus(), units, speed, runs: [] };
  const save = async () => {
    try {
      await new File(Paths.document, 'phonon-selftest.json').write(JSON.stringify(out, null, 1));
    } catch (e) {
      log(`write failed ${String(e)}`);
    }
  };
  const progress: unknown[] = [];
  const subP = stt.addListener('onProgress', (e) => {
    progress.push({ ...e, at: Date.now() });
    if (e.phase !== 'download' || (e.fraction ?? 0) * 100 - Math.floor((e.fraction ?? 0) * 100) < 0.02) log(`progress ${JSON.stringify(e)}`);
  });
  try {
    let dir = model === 'download' ? null : abs(model);
    if (model === 'download') {
      const t = Date.now();
      const r = await stt.downloadModel();
      out.download = { ...r, wallMs: Date.now() - t };
      dir = r.dir;
      log(`download ${JSON.stringify(out.download)}`);
    }
    const t = Date.now();
    out.prepare = { ...(await stt.prepare(dir, { computeUnits: units })), wallMs: Date.now() - t };
    out.progress = progress;
    log(`prepare ${JSON.stringify(out.prepare)}`);
    await save();
    for (const f of files) {
      const path = abs(f);
      const run: Record<string, unknown> = { file: f };
      (out.runs as unknown[]).push(run);
      const off = await stt.transcribeFile(path);
      run.offline = { text: off.text, audioSeconds: off.audioSeconds, decodeMs: off.decodeMs };
      log(`offline ${f} ${off.decodeMs.toFixed(0)} ms: ${off.text}`);
      const partials: PhononPartial[] = [];
      const subA = stt.addListener('onPartial', (e) => {
        partials.push(e);
        log(`partial ${f} t=${e.t.toFixed(2)} audio=${e.audioSeconds.toFixed(2)} fn=${e.function} dec=${e.decodeMs.toFixed(0)}ms ${e.kind} | ${e.committed.slice(-60)} || ${e.tail}`);
      });
      const final = new Promise<PhononFinal>((resolve) => {
        const s = stt.addListener('onFinal', (e) => {
          s.remove();
          resolve(e);
        });
      });
      const t0 = Date.now();
      await stt.startFile(path, { speed, fullPass: true });
      const fin = await final;
      subA.remove();
      run.live = { final: fin, partials, wallMs: Date.now() - t0 };
      log(`final ${f} latency=${fin.latencyMs.toFixed(0)}ms fullPass=${(fin.fullPassMs ?? 0).toFixed(0)}ms: ${fin.text}`);
      await save();
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    log(`error ${String(out.error)}`);
  }
  subP.remove();
  out.done = true;
  await save();
  log('done');
}
