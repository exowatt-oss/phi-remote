// KokoroPlayer.swift: gapless playback of synthesized pieces through one AVAudioEngine + AVAudioPlayerNode.
//
// JS keeps at most two pieces scheduled (one playing, the next queued) and synthesizes the one after while they play, so
// the node never runs dry and stop() has little to throw away. Each piece is trimmed of the model's own leading/trailing
// silence and given the pause JS asks for (longer after a sentence than after a comma), so the joins sound like the
// punctuation, not like the seams.
//
// The engine only drives output: it never touches `inputNode`, so it uses whatever session category the app set
// (expo-audio's `playback`, so AirPods stay on A2DP at full quality) and never asks for a microphone.
import AVFoundation
import Foundation

final class KokoroPlayer {
    static let sampleRate: Double = 24_000

    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: KokoroPlayer.sampleRate, channels: 1, interleaved: false)!
    private let lock = NSLock()
    private var nextId = 0
    private var stored: [Int: AVAudioPCMBuffer] = [:]
    private var waiting: [Int: (Bool) -> Void] = [:]
    private var attached = false
    /// Called when playback ends without stop(): an interruption (call, Siri), a media-services reset or an engine reconfiguration.
    var onInterrupted: ((String) -> Void)?

    init() {
        let center = NotificationCenter.default
        center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            self?.interrupt("The audio route changed.")
        }
        #if os(iOS)
        center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] n in
            let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            if raw == AVAudioSession.InterruptionType.began.rawValue { self?.interrupt("Reading was interrupted.") }
        }
        center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) { [weak self] _ in
            self?.interrupt("Audio services were reset.")
        }
        #endif
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    /// Keeps a piece for play(): trimmed to `lead` / `tail` seconds of the model's own silence, plus `pause` seconds.
    func store(_ samples: [Float], pause: Double) -> (id: Int, seconds: Double) {
        let trimmed = KokoroPlayer.trim(samples)
        let pad = Int(max(0, pause) * KokoroPlayer.sampleRate)
        let count = trimmed.count + pad
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(max(1, count)))!
        buffer.frameLength = AVAudioFrameCount(count)
        let out = buffer.floatChannelData![0]
        trimmed.withUnsafeBufferPointer { src in out.update(from: src.baseAddress!, count: trimmed.count) }
        if pad > 0 { (out + trimmed.count).initialize(repeating: 0, count: pad) }
        lock.lock(); nextId += 1; let id = nextId; stored[id] = buffer; lock.unlock()
        return (id, Double(count) / KokoroPlayer.sampleRate)
    }

    /// Schedules a stored piece after whatever is already scheduled; `done(true)` once it has been heard, `done(false)`
    /// if stop() or an interruption ended it first (or it was never stored).
    func play(_ id: Int, done: @escaping (Bool) -> Void) {
        lock.lock()
        guard let buffer = stored.removeValue(forKey: id) else { lock.unlock(); done(false); return }
        waiting[id] = done
        lock.unlock()
        do {
            try startIfNeeded()
        } catch {
            finish(id, false)
            return
        }
        node.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in self?.finish(id, true) }
        if !node.isPlaying { node.play() }
    }

    private func startIfNeeded() throws {
        if !attached {
            engine.attach(node)
            engine.connect(node, to: engine.mainMixerNode, format: format)
            attached = true
        }
        if !engine.isRunning {
            engine.prepare()
            try engine.start()
        }
    }

    private func finish(_ id: Int, _ heard: Bool) {
        lock.lock(); let cb = waiting.removeValue(forKey: id); lock.unlock()
        cb?(heard)
    }

    /// Stops at once: the node drops everything scheduled, stored pieces are freed, every waiting play() resolves false,
    /// and the engine stops so the app can hand the audio session back.
    func stop() {
        lock.lock()
        let pending = waiting
        waiting.removeAll()
        stored.removeAll()
        lock.unlock()
        if attached { node.stop() }
        if engine.isRunning { engine.stop() }
        for cb in pending.values { cb(false) }
    }

    private func interrupt(_ reason: String) {
        lock.lock(); let active = !waiting.isEmpty; lock.unlock()
        guard active else { return }
        stop()
        onInterrupted?(reason)
    }

    /// Model silence below about -50 dBFS at either end is cut to 40 ms.
    static func trim(_ s: [Float], threshold: Float = 0.003, keep: Int = 960) -> [Float] {
        guard let first = s.firstIndex(where: { abs($0) > threshold }), let last = s.lastIndex(where: { abs($0) > threshold }) else {
            return []
        }
        let a = max(0, first - keep)
        let b = min(s.count, last + 1 + keep)
        return Array(s[a..<b])
    }
}
