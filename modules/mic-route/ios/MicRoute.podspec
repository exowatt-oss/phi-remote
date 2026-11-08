# Local Expo module: which microphone dictation records from (the iPhone's own, or a headset's).
Pod::Spec.new do |s|
  s.name           = 'MicRoute'
  s.version        = '0.1.0'
  s.summary        = 'Choose the microphone dictation records from'
  s.description    = s.summary
  s.license        = { :type => 'MIT' }
  s.author         = 'phi remote'
  s.homepage       = 'https://github.com/exowatt-oss/phi-remote'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.swift'
  s.frameworks = 'AVFoundation'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
