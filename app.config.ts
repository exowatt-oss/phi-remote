import type { ConfigContext, ExpoConfig } from 'expo/config';

const BUILD_NUMBER = process.env.PHI_REMOTE_BUILD_NUMBER?.trim() || '1';
// Replace the example identifier when building for your own Apple/Android team.
const BUNDLE_ID = process.env.PHI_REMOTE_BUNDLE_ID?.trim() || 'com.example.phiremote';
// TestFlight / App Store builds talk to the production APNs gateway. Set
// PHI_REMOTE_APS_ENV=development for a development-signed device build.
const APS_MODE: 'development' | 'production' =
  process.env.PHI_REMOTE_APS_ENV === 'development' ? 'development' : 'production';

const CAMERA = 'phi uses the camera to scan the pairing code shown by phi remote pair on your computer.';
const PHOTOS = 'phi lets you attach photos to a message for the agent.';
const MICROPHONE = 'phi uses the microphone for dictation into the message box.';
// DM Sans (SIL OFL), embedded natively so text renders in it from the first frame.
// iOS registers them by PostScript name: DMSans-Regular / -Italic / -Medium / -Bold.
const DM_SANS = [
  './node_modules/@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf',
  './node_modules/@expo-google-fonts/dm-sans/400Regular_Italic/DMSans_400Regular_Italic.ttf',
  './node_modules/@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf',
  './node_modules/@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf',
];

const LOCAL_NETWORK = 'phi connects to phi remote on your computers over your local network or Tailscale.';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'phi',
  slug: 'phi-remote',
  platforms: ['ios', 'android'],
  scheme: 'phiremote',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  icon: './assets/icon.png',
  ios: {
    bundleIdentifier: BUNDLE_ID,
    buildNumber: BUILD_NUMBER,
    supportsTablet: false,
    config: { usesNonExemptEncryption: false },
    infoPlist: {
      // Hubs are plain http/ws over Tailscale (WireGuard encrypts the path).
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      NSLocalNetworkUsageDescription: LOCAL_NETWORK,
      NSCameraUsageDescription: CAMERA,
      NSPhotoLibraryUsageDescription: PHOTOS,
      NSMicrophoneUsageDescription: MICROPHONE,
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: BUNDLE_ID,
  },
  plugins: [
    'expo-router',
    ['expo-font', { fonts: DM_SANS }],
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 112,
        resizeMode: 'contain',
        backgroundColor: '#FCFCFC',
        dark: { image: './assets/splash-icon-dark.png', backgroundColor: '#0A0A0A' },
      },
    ],
    ['expo-notifications', { mode: APS_MODE }],
    [
      'expo-camera',
      { cameraPermission: CAMERA, microphonePermission: MICROPHONE, recordAudioAndroid: false, barcodeScannerEnabled: true },
    ],
    ['expo-image-picker', { photosPermission: PHOTOS, cameraPermission: CAMERA, microphonePermission: MICROPHONE }],
    // Dictation (T3's engine, DESIGN.md §4a): expo-audio records, Apple SpeechAnalyzer
    // transcribes on-device via @react-native-ai/apple — no speech-recognition permission.
    [
      'expo-audio',
      { microphonePermission: MICROPHONE, recordAudioAndroid: false, enableBackgroundPlayback: false, enableBackgroundRecording: false },
    ],
  ],
  experiments: {
    reactCompiler: true,
  },
});
