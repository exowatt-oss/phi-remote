// PhononEngine.swift: the module's state: one Transcriber (loaded once), one live session at a time, microphone or file feed,
// the model download, and the numbers the app's "Live dictation details" screen shows (memory footprint, thermal state, timings).
import AVFoundation
import CoreML
import ExpoModulesCore
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Extra background time for a download or a Neural Engine compile that is running when the app leaves the foreground.
final class BackgroundTask {
    #if canImport(UIKit)
    private var id = UIBackgroundTaskIdentifier.invalid
    init(_ name: String) {
        DispatchQueue.main.async { [self] in
            id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in self?.end() }
        }
    }
    func end() {
        DispatchQueue.main.async { [self] in
            if id != .invalid { UIApplication.shared.endBackgroundTask(id); id = .invalid }
        }
    }
    #else
    init(_ name: String) {}
    func end() {}
    #endif
}

@available(iOS 18.0, macOS 15.0, *)
extension LiveDictation {
    /// Everything recorded so far (the fallback path hands it to SpeechAnalyzer as a WAV).
    func recordedAudio() -> [Float] { lock.lock(); defer { lock.unlock() }; return all }
}

@available(iOS 18.0, *)
final class PhononEngine {
    typealias Emit = (String, [String: Any]) -> Void
    private let emit: Emit
    private let setupQueue = DispatchQueue(label: "phonon.setup", qos: .userInitiated)
    private let finishQueue = DispatchQueue(label: "phonon.finish", qos: .userInitiated)
    private let lock = NSLock()
    private var transcriber: Transcriber?
    private var preparing = false
    private var live: LiveSession?
    private var mic: MicCapture?
    private var feeder: DispatchSourceTimer?
    private var releaseSession = false
    private var stopping = false
    private var degraded = false
    private var store: ModelStore?
    private var lastLevelAt = Date.distantPast
    // per-session numbers for the diagnostics screen
    private var footprintStart = 0.0, footprintPeak = 0.0
    private var thermalStart = ""

    init(emit: @escaping Emit) {
        // QA: launch argument -phiPhononLog YES also writes every event to the system log (Release builds drop console.log)
        if UserDefaults.standard.bool(forKey: "phiPhononLog") {
            self.emit = { name, body in
                if name != "onLevel" { NSLog("[phonon] %@ %@", name, String(describing: body)) }
                emit(name, body)
            }
        } else { self.emit = emit }
    }

    // MARK: model
    func modelStatus() -> [String: Any] {
        let s = ModelStore()
        return ["ready": s.isReady, "dir": s.root.path, "bytesOnDisk": s.bytesOnDisk(), "revision": ModelStore.revision,
                "downloadBytes": ModelStore.totalBytes, "prepared": isPrepared, "preparing": isPreparing]
    }

    var isPrepared: Bool { lock.lock(); defer { lock.unlock() }; return transcriber != nil }
    var isPreparing: Bool { lock.lock(); defer { lock.unlock() }; return preparing }

    /// Download (resumable) + verify + compile. options: { allowCellular?: boolean } (default false: Wi-Fi only).
    func downloadModel(options: [String: Any], promise: Promise) {
        let s = ModelStore(allowCellular: (options["allowCellular"] as? Bool) ?? false)
        lock.lock()
        if store != nil { lock.unlock(); return promise.reject("ERR_PHONON_BUSY", "The model is already downloading.") }
        store = s
        lock.unlock()
        var last = -1.0
        s.progress = { [weak self] f, file in
            if f - last >= 0.005 || f >= 1 {
                last = f
                self?.emit("onProgress", ["phase": file == "compiling" ? "compiling" : "download", "fraction": f, "file": file])
            }
        }
        let bg = BackgroundTask("phonon-download")
        Task.detached { [weak self] in
            defer { bg.end() }
            do {
                let t = Date()
                let dir = try await s.ensure()
                self?.clearStore(s)
                promise.resolve(["dir": dir.path, "seconds": Date().timeIntervalSince(t)])
            } catch {
                self?.clearStore(s)
                if case ModelStore.Failure.cancelled = error { return promise.reject("ERR_PHONON_CANCELLED", "Model download cancelled.") }
                promise.reject("ERR_PHONON_DOWNLOAD", error.localizedDescription)
            }
        }
    }
    private func clearStore(_ s: ModelStore) { lock.lock(); if store === s { store = nil }; lock.unlock() }

    func cancelDownload() {
        lock.lock(); let s = store; store = nil; lock.unlock()
        s?.cancel()
    }

    /// Loads the encoder functions; options: { functions?: number[] (default [10]), computeUnits?: "ane"|"cpu"|"gpu"|"all" }.
    /// The first load per OS build compiles the encoder for the Neural Engine (minutes); later loads take well under a second.
    func prepare(modelDir: String?, options: [String: Any], promise: Promise) {
        lock.lock()
        if transcriber != nil { lock.unlock(); return promise.resolve(["loadSeconds": 0, "alreadyPrepared": true]) }
        if preparing { lock.unlock(); return promise.reject("ERR_PHONON_BUSY", "The model is already being prepared.") }
        preparing = true
        lock.unlock()
        let bg = BackgroundTask("phonon-prepare")
        setupQueue.async { [self] in
            defer { bg.end() }
            let before = DeviceStats.footprintMB()
            var peak = before
            let sampler = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "phonon.sampler", qos: .utility))
            let peakLock = NSLock()
            sampler.schedule(deadline: .now(), repeating: .milliseconds(250))
            sampler.setEventHandler { let f = DeviceStats.footprintMB(); peakLock.lock(); peak = max(peak, f); peakLock.unlock() }
            sampler.resume()
            let thermal = DeviceStats.thermalState()
            do {
                let dir = modelDir.map { URL(fileURLWithPath: $0.hasPrefix("file://") ? String($0.dropFirst(7)) : $0) } ?? ModelStore().root
                var o = Transcriber.Options()
                // default: only the 10 s function: one Neural Engine compile instead of three, same accuracy, ~40 ms updates (REPORT.md)
                let fs = (options["functions"] as? [NSNumber])?.map(\.doubleValue) ?? [10]
                o.functions = fs; o.eagerFunctions = fs; o.singleShotMaxSeconds = fs.max()
                if let m = fs.max(), m < 15 { o.windowSeconds = m; o.bandMinSeconds = m * 2 / 3 }   // long reads: windows the largest function holds
                let units: String
                switch options["computeUnits"] as? String {
                case "cpu": o.computeUnits = .cpuOnly; units = "cpuOnly"
                case "gpu": o.computeUnits = .cpuAndGPU; units = "cpuAndGPU"
                case "all": o.computeUnits = .all; units = "all"
                default: o.computeUnits = .cpuAndNeuralEngine; units = "cpuAndNeuralEngine"
                }
                o.progress = { [weak self] phase, t in self?.emit("onProgress", ["phase": phase, "seconds": t]) }
                let t = Date()
                let tr = try Transcriber(bundle: dir, options: o)
                sampler.cancel()
                lock.lock(); transcriber = tr; preparing = false; lock.unlock()
                let after = DeviceStats.footprintMB()
                peakLock.lock(); let p = max(peak, after); peakLock.unlock()
                promise.resolve(["loadSeconds": Date().timeIntervalSince(t), "compileSeconds": tr.compileSeconds,
                                 "functionLoadSeconds": Dictionary(uniqueKeysWithValues: tr.functionLoadSeconds.map { ("\($0.key)", $0.value) }),
                                 "compiledModel": tr.compiledURL.path, "computeUnits": units, "functions": fs,
                                 "footprintBeforeMB": before, "footprintAfterMB": after, "footprintPeakMB": p,
                                 "thermalStart": thermal, "thermalEnd": DeviceStats.thermalState()])
            } catch {
                sampler.cancel()
                lock.lock(); preparing = false; lock.unlock()
                promise.reject("ERR_PHONON_PREPARE", error.localizedDescription)
            }
        }
    }

    /// Frees the loaded model (~110 MB on the Neural Engine path; GBs on a CPU fallback). The next prepare() loads it again.
    func unload() {
        lock.lock(); let busy = live != nil; if !busy { transcriber = nil }; lock.unlock()
    }

    /// Deletes the downloaded model (and any partial download) and unloads it.
    func removeModel(promise: Promise) {
        cancel()
        cancelDownload()
        lock.lock(); transcriber = nil; lock.unlock()
        setupQueue.async { [self] in   // after a prepare in flight, which would otherwise leave the model loaded
            lock.lock(); transcriber = nil; lock.unlock()
            do { try ModelStore.removeAll(); promise.resolve(nil) } catch { promise.reject("ERR_PHONON_REMOVE", error.localizedDescription) }
        }
    }
}

// MARK: live
@available(iOS 18.0, *)
extension PhononEngine {
    private func makeSession(_ options: [String: Any]) throws -> LiveSession {
        lock.lock(); let tr = transcriber; let busy = live != nil; lock.unlock()
        guard let tr else { throw NSError(domain: "PhononStt", code: 1, userInfo: [NSLocalizedDescriptionKey: "Call prepare() first."]) }
        guard !busy else { throw NSError(domain: "PhononStt", code: 2, userInfo: [NSLocalizedDescriptionKey: "A dictation is already running."]) }
        var c = LiveDictation.Config()
        if let v = options["interval"] as? Double { c.updateInterval = v }
        if let v = options["maxTail"] as? Double { c.maxTailSeconds = v }
        if let v = options["pause"] as? Double { c.pauseCommitSeconds = v }
        let s = LiveSession(engine: LiveDictation(transcriber: tr, config: c))
        let t0 = Date()
        s.onUpdate = { [weak self] u in
            guard let self else { return }
            let f = DeviceStats.footprintMB()
            self.lock.lock(); self.footprintPeak = max(self.footprintPeak, f); self.lock.unlock()
            self.emit("onPartial", ["committed": u.committed, "tail": u.tail, "kind": u.kind.rawValue, "audioSeconds": u.audioSeconds,
                                    "decodeMs": u.decodeMs, "function": u.function, "decodedSeconds": u.decodedSeconds,
                                    "t": Date().timeIntervalSince(t0), "footprintMB": f])
        }
        s.onError = { [weak self] e in self?.emit("onError", ["message": e.localizedDescription]) }
        return s
    }

    private func beginStats() {
        let f = DeviceStats.footprintMB()
        lock.lock(); footprintStart = f; footprintPeak = f; thermalStart = DeviceStats.thermalState(); degraded = false; lock.unlock()
    }

    func startMic(options: [String: Any], promise: Promise) {
        do {
            let s = try makeSession(options)
            beginStats()
            let m = MicCapture()
            m.onSamples = { [weak self, weak s] samples, rms in
                s?.append(samples)
                guard let self, Date().timeIntervalSince(self.lastLevelAt) >= 0.08 else { return }
                self.lastLevelAt = Date(); self.emit("onLevel", ["level": rms])
            }
            m.onInterrupted = { [weak self] message in self?.emit("onInterrupted", ["message": message]) }
            let configure = (options["configureAudioSession"] as? Bool) ?? true
            try m.start(configureSession: configure, headset: (options["mic"] as? String) == "headset")
            lock.lock(); live = s; mic = m; releaseSession = configure; stopping = false; lock.unlock()
            s.start()
            promise.resolve(["thermalState": thermalStart, "footprintMB": footprintStart])
        } catch { promise.reject("ERR_PHONON_START", error.localizedDescription) }
    }

    /// The live loop fed from a file at `speed` x real time in 100 ms chunks (the Simulator has no microphone); at the end of the
    /// file it stops by itself (onFinal) unless `autoStop` is false. Levels are emitted from the file's audio for the waveform.
    func startFile(path: String, options: [String: Any], promise: Promise) {
        do {
            let s = try makeSession(options)
            beginStats()
            let url = URL(fileURLWithPath: path.hasPrefix("file://") ? String(path.dropFirst(7)) : path)
            let samples = try FileSource(url: url).readAll()
            let speed = max(0.1, (options["speed"] as? Double) ?? 1)
            let autoStop = (options["autoStop"] as? Bool) ?? true
            let fullPass = (options["fullPass"] as? Bool) ?? false
            let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "phonon.feeder", qos: .userInitiated))
            var i = 0
            let t0 = Date()
            timer.setEventHandler { [weak self, weak s] in
                guard let self, let s else { return }
                // append every chunk whose audio has "arrived" by now
                let due = min(samples.count, Int(Date().timeIntervalSince(t0) * speed * 16000) / 1600 * 1600)
                var level: Float = -1
                while i < due {
                    let j = min(samples.count, i + 1600); let chunk = Array(samples[i..<j])
                    var sum: Float = 0; for v in chunk { sum += v * v }; level = (sum / Float(max(1, chunk.count))).squareRoot()
                    s.append(chunk); i = j
                }
                if level >= 0 { self.emit("onLevel", ["level": level]) }
                if i >= samples.count {
                    self.lock.lock(); self.feeder?.cancel(); self.feeder = nil; self.lock.unlock()
                    if autoStop { self.finish(fullPass: fullPass, decode: true, audioPath: nil, promise: nil) }
                }
            }
            lock.lock(); live = s; feeder = timer; releaseSession = false; stopping = false; lock.unlock()
            timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(Int(100 / speed)), leeway: .milliseconds(5))
            s.start(); timer.resume()
            promise.resolve(["audioSeconds": Double(samples.count) / 16000])
        } catch { promise.reject("ERR_PHONON_START", error.localizedDescription) }
    }

    /// Too slow for live updates (the app's performance guard): stop re-reading, keep capturing. stop() then either reads
    /// everything once (decode: true) or hands the audio over as a WAV (decode: false, audioPath).
    func degrade() {
        lock.lock(); let s = live; degraded = s != nil; lock.unlock()
        s?.cancel()
    }

    /// options: { fullPass?, decode? (default true), audioPath? (write the whole recording as 16 kHz 16-bit WAV) }
    func stop(options: [String: Any], promise: Promise) {
        finish(fullPass: (options["fullPass"] as? Bool) ?? false, decode: (options["decode"] as? Bool) ?? true,
               audioPath: options["audioPath"] as? String, promise: promise)
    }

    private func finish(fullPass: Bool, decode: Bool, audioPath: String?, promise: Promise?) {
        lock.lock()
        guard let s = live, !stopping else { lock.unlock(); promise?.reject("ERR_PHONON_STOP", "No dictation is running."); return }
        stopping = true
        let m = mic, f = feeder, rel = releaseSession, wasDegraded = degraded
        mic = nil; feeder = nil
        lock.unlock()
        f?.cancel()
        m?.stop(releaseSession: rel)
        let tStop = Date()
        finishQueue.async { [self] in
            do {
                var body: [String: Any] = ["degraded": wasDegraded]
                if let audioPath {
                    let url = URL(fileURLWithPath: audioPath.hasPrefix("file://") ? String(audioPath.dropFirst(7)) : audioPath)
                    try DeviceStats.writeWAV(s.engine.recordedAudio(), sampleRate: LiveDictation.sampleRate, to: url)
                    body["audioUri"] = url.absoluteString
                }
                if decode {
                    let u = try s.stop()
                    body["text"] = u.committed; body["audioSeconds"] = u.audioSeconds; body["finalDecodeMs"] = u.decodeMs
                    if fullPass, let fp = try? s.engine.fullPass() { body["fullPassText"] = fp.text; body["fullPassMs"] = fp.ms }
                } else {
                    s.cancel()
                    body["text"] = ""; body["audioSeconds"] = s.engine.audioSeconds; body["finalDecodeMs"] = 0
                }
                body["latencyMs"] = Date().timeIntervalSince(tStop) * 1000
                body["updates"] = s.engine.updates
                let fEnd = DeviceStats.footprintMB()
                lock.lock()
                body["footprintStartMB"] = footprintStart; body["footprintPeakMB"] = max(footprintPeak, fEnd); body["footprintEndMB"] = fEnd
                body["thermalStart"] = thermalStart
                live = nil; stopping = false
                lock.unlock()
                body["thermalEnd"] = DeviceStats.thermalState()
                emit("onFinal", body)
                promise?.resolve(body)
            } catch {
                lock.lock(); live = nil; stopping = false; lock.unlock()
                emit("onError", ["message": error.localizedDescription])
                promise?.reject("ERR_PHONON_STOP", error.localizedDescription)
            }
        }
    }

    /// ✕: drop the live session, no events. Never touches a model download running in the background.
    func cancel() {
        lock.lock(); let s = live, m = mic, f = feeder, rel = releaseSession; live = nil; mic = nil; feeder = nil; stopping = false; lock.unlock()
        f?.cancel(); m?.stop(releaseSession: rel); s?.cancel()
    }

    func transcribeFile(path: String, promise: Promise) {
        setupQueue.async { [self] in
            lock.lock(); let tr = transcriber; lock.unlock()
            guard let tr else { return promise.reject("ERR_PHONON_PREPARE", "Call prepare() first.") }
            do {
                let url = URL(fileURLWithPath: path.hasPrefix("file://") ? String(path.dropFirst(7)) : path)
                let samples = try FileSource(url: url).readAll()
                let t = Date()
                let r = try tr.transcribe(samples)
                promise.resolve(["text": r.text, "audioSeconds": r.audioSeconds, "decodeMs": Date().timeIntervalSince(t) * 1000, "windows": r.windows,
                                 "words": r.words.map { ["text": $0.text, "start": $0.start, "end": $0.end] }])
            } catch { promise.reject("ERR_PHONON_TRANSCRIBE", error.localizedDescription) }
        }
    }
}
