/**
 * Rewrites incoming system links before routing:
 *   phiremote://pair?…                 → the pairing screen, with the whole link to parse
 *   phiremote://session/<hub>/<sess>   → routed as-is to the thread
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    if (/^(?:phiremote:\/{1,3})?\/?pair(?:[/?#]|$)/i.test(path)) {
      const link = /^phiremote:/i.test(path) ? path : `phiremote://${path.replace(/^\/+/, '')}`;
      return `/hosts/pair?link=${encodeURIComponent(link)}`;
    }
    return path;
  } catch {
    return '/';
  }
}
