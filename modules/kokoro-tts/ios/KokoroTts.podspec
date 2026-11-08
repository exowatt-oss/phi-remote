# Local Expo module: read-aloud with Kokoro-82M on this iPhone (Core ML: Neural Engine + GPU).
# Vendors the parts of FluidAudio (Apache-2.0) the English ANE-v3 Kokoro runtime needs (FluidKokoro/, see VENDORED.md) into one
# pod, so the app needs no Swift Package Manager integration. Everything iOS 18-only is behind @available; the module loads on
# older iOS and reports isAvailable() == false there.
Pod::Spec.new do |s|
  s.name           = 'KokoroTts'
  s.version        = '0.1.0'
  s.summary        = 'On-device read-aloud with Kokoro-82M Core ML'
  s.description    = s.summary
  s.license        = { :type => 'Apache-2.0' }
  s.author         = 'phi remote'
  s.homepage       = 'https://huggingface.co/FluidInference/kokoro-82m-coreml'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.swift', 'FluidKokoro/*.swift'
  s.frameworks = 'CoreML', 'Accelerate', 'AVFoundation'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => '$(inherited) TTS',
  }
end
