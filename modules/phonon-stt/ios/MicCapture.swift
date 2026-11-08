// MicCapture.swift: AVAudioEngine input tap -> 16 kHz mono Float32 for LiveDictation, plus an RMS level per buffer for the waveform.
// A route change (AirPods in or out) restarts the tap with the new input format; an audio-session interruption (a call, Siri) or a
// media-services reset ends the capture through `onInterrupted`, like expo-audio's recorder does for the standard path.
import AVFoundation
import Foundation

final class MicCapture {
    static let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    let engine = AVAudioEngine()
    var converter: AVAudioConverter?
    var onSamples: (([Float], Float) -> Void)?   // 16 kHz mono samples, RMS of the buffer (0...1)
    var onInterrupted: ((String) -> Void)?
    private(set) var running = false
    private var observers: [NSObjectProtocol] = []

    enum Failure: LocalizedError {
        case noInput, converter
        var errorDescription: String? {
            switch self {
            case .noInput: return "No microphone input is available."
            case .converter: return "Could not convert the microphone audio to 16 kHz."
            }
        }
    }

    /// Configures the shared audio session for recording (unless the app already did) and starts the tap. Unless `headset`, the input
    /// is the built-in mic and headphones keep playing over A2DP (HFP would take the input and drop them to call-quality audio).
    func start(configureSession: Bool, headset: Bool = false) throws {
        #if os(iOS)
        if configureSession {
            let s = AVAudioSession.sharedInstance()
            try s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, headset ? AVAudioSession.CategoryOptions.allowBluetoothHFP : .allowBluetoothA2DP])
            try s.setActive(true)
            if !headset, let mic = s.availableInputs?.first(where: { $0.portType == .builtInMic }) { try? s.setPreferredInput(mic) }
        }
        #endif
        try installTap()
        engine.prepare()
        try engine.start()
        running = true
        observe()
    }

    private func installTap() throws {
        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.channelCount > 0, inFormat.sampleRate > 0 else { throw Failure.noInput }
        guard let conv = AVAudioConverter(from: inFormat, to: MicCapture.format) else { throw Failure.converter }
        converter = conv
        let ratio = 16000 / inFormat.sampleRate
        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(inFormat.sampleRate / 10), format: inFormat) { [weak self] buf, _ in
            guard let self, let conv = self.converter else { return }
            let cap = AVAudioFrameCount(Double(buf.frameLength) * ratio) + 64
            guard let out = AVAudioPCMBuffer(pcmFormat: MicCapture.format, frameCapacity: cap) else { return }
            var fed = false, err: NSError?
            conv.convert(to: out, error: &err) { _, status in
                if fed { status.pointee = .noDataNow; return nil }
                fed = true; status.pointee = .haveData; return buf
            }
            let n = Int(out.frameLength); guard n > 0, let p = out.floatChannelData?[0] else { return }
            let samples = Array(UnsafeBufferPointer(start: p, count: n))
            var sum: Float = 0; for v in samples { sum += v * v }
            self.onSamples?(samples, (sum / Float(n)).squareRoot())
        }
    }

    private func observe() {
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            self?.restart()
        })
        #if os(iOS)
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] n in
            guard let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            self?.interrupted("Voice recording was interrupted.")
        })
        observers.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) { [weak self] _ in
            self?.interrupted("Voice recording was interrupted.")
        })
        #endif
    }

    /// The input route changed: the engine stopped itself; reinstall the tap with the new input format.
    private func restart() {
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        do {
            try installTap()
            engine.prepare()
            try engine.start()
        } catch {
            interrupted("The microphone changed and could not restart.")
        }
    }

    private func interrupted(_ message: String) {
        guard running else { return }
        onInterrupted?(message)
    }

    func stop(releaseSession: Bool) {
        for o in observers { NotificationCenter.default.removeObserver(o) }
        observers.removeAll()
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        running = false
        #if os(iOS)
        if releaseSession {
            try? AVAudioSession.sharedInstance().setPreferredInput(nil)
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        #endif
    }
}
