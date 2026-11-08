// KokoroUtil.swift: memory footprint (what jetsam counts), a 16-bit WAV writer, and the QA-only system-voice renderer.
import AVFoundation
import Foundation

enum KokoroUtil {
    /// Largest absolute sample (0 for empty; infinity when any sample is not finite).
    static func peak(_ s: [Float]) -> Float {
        var m: Float = 0
        for x in s {
            guard x.isFinite else { return .infinity }
            m = max(m, abs(x))
        }
        return m
    }

    /// nil when the samples look like speech; else what is wrong. Kokoro's speech peaks around 0.3-0.8; silence or values
    /// far outside [-1, 1] mean Core ML mis-executed the model on this device (seen in the iOS Simulator).
    static func audioProblem(_ s: [Float]) -> String? {
        let p = peak(s)
        if p <= 0.003 { return "no sound" }
        if p > 2 { return "garbled audio" }
        return nil
    }

    /// "iPhone18,1" (the Simulator: the model it simulates).
    static func deviceModel() -> String {
        if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return "\(sim) (Simulator)" }
        var u = utsname()
        uname(&u)
        return withUnsafeBytes(of: &u.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
    }

    /// Bytes in Core ML's compile cache (e5rt) for this app (`Library/Caches/**/com.apple.e5rt.e5bundlecache`); -1 = none.
    static func aneCacheBytes() -> Int64 {
        let fm = FileManager.default
        guard let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask).first,
              let e = fm.enumerator(at: caches, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])
        else { return -1 }
        var total: Int64 = -1
        for case let u as URL in e {
            if e.level > 3 { e.skipDescendants(); continue }
            guard u.lastPathComponent == "com.apple.e5rt.e5bundlecache" else { continue }
            e.skipDescendants()
            total = max(total, 0)
            if let inner = fm.enumerator(at: u, includingPropertiesForKeys: [.fileSizeKey]) {
                for case let f as URL in inner { total += Int64((try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
            }
        }
        return total
    }

    static func osVersion() -> String { ProcessInfo.processInfo.operatingSystemVersionString }

    static func footprintMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return kr == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : 0
    }

    /// Mono float samples -> 16-bit PCM WAV.
    static func writeWAV(_ samples: [Float], sampleRate: Int, to url: URL) throws {
        var data = Data(capacity: 44 + samples.count * 2)
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        let bytes = UInt32(samples.count * 2)
        data.append(contentsOf: Array("RIFF".utf8)); u32(36 + bytes); data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 2)); u16(2); u16(16)
        data.append(contentsOf: Array("data".utf8)); u32(bytes)
        for s in samples {
            let v = Int16(max(-1, min(1, s)) * 32767)
            withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) }
        }
        try data.write(to: url, options: .atomic)
    }
}

/// QA only: the system voice (AVSpeechSynthesizer, what read-aloud used before) rendered to a WAV for side-by-side listening.
enum SystemVoiceWriter {
    static func write(_ text: String, voiceId: String?, rate: Float, path: String) async throws -> [String: Any] {
        let url = path.hasPrefix("file://") ? URL(string: path)! : URL(fileURLWithPath: path)
        let utterance = AVSpeechUtterance(string: text)
        if let voiceId, let v = AVSpeechSynthesisVoice(identifier: voiceId) { utterance.voice = v }
        else { utterance.voice = AVSpeechSynthesisVoice(language: "en-US") }
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * rate
        let synth = AVSpeechSynthesizer()
        var file: AVAudioFile?
        var frames: AVAudioFramePosition = 0
        var sampleRate = 22_050.0
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            var finished = false
            synth.write(utterance) { buffer in
                guard !finished, let pcm = buffer as? AVAudioPCMBuffer else { return }
                if pcm.frameLength == 0 { finished = true; cont.resume(); return }
                do {
                    if file == nil {
                        sampleRate = pcm.format.sampleRate
                        file = try AVAudioFile(forWriting: url, settings: pcm.format.settings, commonFormat: pcm.format.commonFormat, interleaved: pcm.format.isInterleaved)
                    }
                    try file?.write(from: pcm)
                    frames += AVAudioFramePosition(pcm.frameLength)
                } catch {
                    finished = true; cont.resume(throwing: error)
                }
            }
        }
        _ = synth
        return ["seconds": Double(frames) / sampleRate, "voice": utterance.voice?.identifier ?? "", "voiceName": utterance.voice?.name ?? ""]
    }
}
