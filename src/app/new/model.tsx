/** Model and effort for a new thread; the pick is saved as the default for every new thread. */

import { NewThreadPicker } from '@/components/new-thread-picker';
import { useNewThreadHubId } from '@/services/new-thread';

export default function NewThreadModel() {
  const hubId = useNewThreadHubId();
  return <NewThreadPicker hubId={hubId} />;
}
