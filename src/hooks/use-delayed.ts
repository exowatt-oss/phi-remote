import { useEffect, useMemo, useState } from 'react';

/** `value` once it has stayed true for `ms` (connection status shows after 800 ms only). */
export function useDelayed(value: boolean, ms: number): boolean {
  // A fresh token each time `value` turns true; the timer marks that episode as shown.
  const episode = useMemo(() => (value ? {} : null), [value]);
  const [shown, setShown] = useState<object | null>(null);
  useEffect(() => {
    if (!episode) return;
    const t = setTimeout(() => setShown(episode), ms);
    return () => clearTimeout(t);
  }, [episode, ms]);
  return episode !== null && shown === episode;
}
