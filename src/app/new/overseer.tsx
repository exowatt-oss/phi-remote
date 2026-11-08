/** Thread defaults for an overseer started from New thread; the pick is saved as the default. */

import { OverseerDefaultsForm } from '@/components/overseer/defaults-form';
import { resolveNewThread } from '@/lib/new-thread';
import { useRemote } from '@/services/remote';
import { useHubModels, useNewThreadHubId } from '@/services/new-thread';

export default function NewOverseerDefaults() {
  const hubId = useNewThreadHubId();
  const live = useRemote((s) => (hubId ? s.hosts[hubId]?.conn.status === 'live' : false));
  const { models } = useHubModels(hubId, live);
  const saved = useRemote((s) => s.prefs.newThread);
  const choice = resolveNewThread(saved, models);
  return <OverseerDefaultsForm overseerModel={choice.effort ? `${choice.name} · ${choice.effort}` : choice.name} />;
}
