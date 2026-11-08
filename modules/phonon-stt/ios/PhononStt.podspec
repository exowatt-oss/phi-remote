# Local Expo module: on-device live dictation with Phonon-2 (Core ML on the Neural Engine).
# Vendors the phonon-coreml Swift sources (PhononCoreML/) and the prebuilt decoder (PhononTDT.xcframework) into one pod, so the
# app needs no Swift Package Manager integration. Everything iOS 18-only is behind @available; the module loads on older iOS and
# reports isAvailable() == false there.
Pod::Spec.new do |s|
  s.name           = 'PhononStt'
  s.version        = '0.1.0'
  s.summary        = 'On-device live dictation with Phonon-2 Core ML'
  s.description    = s.summary
  s.license        = { :type => 'Apache-2.0' }
  s.author         = 'phi remote'
  s.homepage       = 'https://huggingface.co/FermionResearch/Phonon-2-CoreML'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.swift', 'PhononCoreML/*.swift'
  s.vendored_frameworks = 'PhononTDT.xcframework'
  s.frameworks = 'CoreML', 'Accelerate', 'AVFoundation', 'Network'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
  }
end
