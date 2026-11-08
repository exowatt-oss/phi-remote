/** Thread defaults from Add thread; the pick is saved as the default for every overseer. */

import { useLocalSearchParams } from 'expo-router';

import { OverseerDefaultsForm } from '@/components/overseer/defaults-form';
import { modelLabel } from '@/lib/format';
import { useRemote } from '@/services/remote';

export default function AddThreadDefaults() {
  const params = useLocalSearchParams<{ hubId: string; sessionId: string }>();
  const summary = useRemote((s) => s.sessions[String(params.hubId ?? '')]?.[String(params.sessionId ?? '')]);
  const own = summary?.model ? [modelLabel(summary.model), summary.thinkingLevel].filter(Boolean).join(' · ') : null;
  return <OverseerDefaultsForm overseerModel={own} />;
}
