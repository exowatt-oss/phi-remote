/**
 * mic-route: which microphone dictation records from (local Expo module, iOS).
 *
 *   prefer('iphone')   select the iPhone's built-in mic, and select it again after every route change
 *                      (headphones connecting mid-dictation) until release()
 *   prefer('headset')  select a headset's mic instead (Bluetooth, then wired, then USB)
 *   release()          stop watching and clear the preference (iOS chooses again)
 *
 * Call prefer() with the recording session active. With no such port, iOS's own choice stays
 * (`action: 'system'`). Each report is also logged natively (subsystem com.example.phiremote,
 * category mic-route, level info). `null` on Android / web / Expo Go (no native module).
 */
import { NativeModule, requireOptionalNativeModule } from 'expo';

export type MicChoice = 'iphone' | 'headset';

export type AudioPort = {
  /** AVAudioSession port type, e.g. MicrophoneBuiltIn, BluetoothHFP, MicrophoneWired, BluetoothA2DPOutput, Speaker. */
  type: string;
  name: string;
  uid: string;
};

export type MicRouteReport = {
  /** The preference in force (null after release). */
  mic: MicChoice | null;
  /** 'prefer' | 'release' | 'route-change:<why>' */
  reason: string;
  /** selected: setPreferredInput ran · kept: already on it · system: no such port, iOS decides · cleared · failed · none */
  action: 'selected' | 'kept' | 'system' | 'cleared' | 'failed' | 'none';
  /** The active input after this step. */
  input: AudioPort | null;
  outputs: AudioPort[];
  preferred: AudioPort | null;
  available: AudioPort[];
  category: string;
  /** Category options in force, e.g. ['allowBluetoothA2DP', 'defaultToSpeaker'] (HFP only for 'headset'). */
  options: string[];
  error?: string;
};

declare class MicRouteModule extends NativeModule<{ onRouteChange: (report: MicRouteReport) => void }> {
  prefer(mic: MicChoice): Promise<MicRouteReport>;
  release(): Promise<MicRouteReport>;
}

const MicRoute = requireOptionalNativeModule<MicRouteModule>('MicRoute');
export default MicRoute;
