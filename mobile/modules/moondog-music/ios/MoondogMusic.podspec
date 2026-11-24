Pod::Spec.new do |s|
  s.name = 'MoondogMusic'
  s.version = '0.1.0'
  s.summary = 'Apple Music playback in Moondog on iPhone'
  s.author = 'Audiofool'
  s.license = 'Apache-2.0'
  s.homepage = 'https://github.com/Audiofool934/moondog'
  s.source = { :git => 'https://github.com/Audiofool934/moondog.git' }
  s.platform = :ios, '16.4'
  s.swift_version = '5.9'
  s.source_files = '*.swift'
  s.frameworks = 'MusicKit', 'Combine'
  s.dependency 'ExpoModulesCore'
  s.static_framework = true
end
