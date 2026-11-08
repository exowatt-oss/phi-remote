/** Settings › New threads: the model and effort every new thread starts with. */

import { NewThreadPicker } from '@/components/new-thread-picker';
import { useNewThreadHubId } from '@/services/new-thread';

export default function SettingsNewThread() {
  const hubId = useNewThreadHubId(true);
  return <NewThreadPicker hubId={hubId} />;
}
