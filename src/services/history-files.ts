/**
 * Plain JSON files in the app's Documents folder (expo-file-system), behind the tiny FileStore
 * interface: the session-history cache in Documents/history (the merged session index and the
 * newest page of recently opened transcripts) and the connection log in Documents/diagnostics.
 * Never secrets (device tokens stay in the keychain via expo-secure-store).
 */

import { Directory, File, Paths } from 'expo-file-system';

import type { FileStore } from '@/lib/history-cache';

const NAME = /^[A-Za-z0-9._-]+$/;

/** A FileStore over Documents/<dirName>. */
export function documentFiles(dirName: string): FileStore {
  const dir = (): Directory => {
    const d = new Directory(Paths.document, dirName);
    if (!d.exists) d.create({ intermediates: true, idempotent: true });
    return d;
  };
  const file = (name: string): File => {
    if (!NAME.test(name)) throw new Error(`bad cache file name ${name}`);
    return new File(dir(), name);
  };
  return {
    async read(name) {
      const f = file(name);
      return f.exists ? f.text() : null;
    },
    async write(name, data) {
      const f = file(name);
      if (!f.exists) f.create({ intermediates: true });
      await f.write(data);
    },
    async remove(name) {
      const f = file(name);
      if (f.exists) f.delete();
    },
  };
}

export const historyFiles: FileStore = documentFiles('history');

/** Documents/diagnostics: connection-log.json (readable from the Simulator's app container). */
export const diagnosticsFiles: FileStore = documentFiles('diagnostics');
