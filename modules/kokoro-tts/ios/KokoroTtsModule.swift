// KokoroTtsModule.swift: Expo module for read-aloud with Kokoro-82M on this iPhone (Core ML, FluidAudio's ANE-v3 runtime).
//
// JS API (see ../index.ts):
//   isAvailable()                               iOS 18+ (the v3 Core ML programs)
//   getModelStatus()                            { ready, damaged, missing, bytesOnDisk, downloadBytes, revision, dir }
//   downloadModel({ allowCellular? })           first-use download (resumable, SHA-256 checked) + compile; onProgress
//   cancelDownload() / removeModel()            stop a download (partial files stay) / delete everything
//   load({ lexicon?, units?, timeoutMs? })      load every stage with 'ane' | 'gpu' | 'cpu' compute units + warm up, within the
//                                               timeout (first ANE load per iOS build: Neural Engine compile); onLoadProgress
//   unload()                                    free the model; a load in progress rejects with ERR_KOKORO_UNLOADED
//   diagnostics()                               Settings › Voice › Diagnostics: device, files, compute units, native log
//   setLexicon({ word: ipa })                   pronunciation overrides checked before the Misaki lexicon
//   phonemes(text)                              the phoneme string the model would read (diagnostics)
//   synthesize(text, { voice, speed, pause })   one piece -> { id, seconds, synthMs, ... } kept natively for play()
//   play(id)                                    schedule after what is playing; resolves true when heard, false when stopped
//   stop()                                      stop at once, drop everything stored
//   writeWav(pieces, { voice, speed, pauses }, path)  QA / samples: the pieces as the player joins them, to a 24 kHz WAV
//   writeSystemWav(text, { voiceId, rate }, path)  QA: the old AVSpeechSynthesizer voice to a WAV, for comparison
import AVFoundation
import ExpoModulesCore
import Foundation
import os

public class KokoroTtsModule: Module {
    private var service: AnyObject?   // KokoroService (iOS 18+); AnyObject so the module itself loads on any iOS
    private let player = KokoroPlayer()

    @available(iOS 18.0, *)
    private var tts: KokoroService {
        if let s = service as? KokoroService { return s }
        let s = KokoroService(player: player) { [weak self] name, body in self?.sendEvent(name, body) }
        service = s
        return s
    }

    private func unavailable() -> Error { Exception(name: "ERR_KOKORO_UNAVAILABLE", description: "iOS 18 or later is required.", code: "ERR_KOKORO_UNAVAILABLE") }

    public func definition() -> ModuleDefinition {
        Name("KokoroTts")
        Events("onProgress", "onLoadProgress", "onInterrupted")

        OnCreate {
            self.player.onInterrupted = { [weak self] reason in self?.sendEvent("onInterrupted", ["message": reason]) }
        }

        Function("isAvailable") { () -> Bool in
            if #available(iOS 18.0, *) { return true }
            return false
        }
        Function("getModelStatus") { () -> [String: Any] in
            guard #available(iOS 18.0, *) else { return ["ready": false, "bytesOnDisk": 0, "downloadBytes": 0] }
            return self.tts.status()
        }
        Function("footprintMB") { () -> Double in KokoroUtil.footprintMB() }
        AsyncFunction("downloadModel") { (options: [String: Any]?) async throws -> [String: Any] in
            guard #available(iOS 18.0, *) else { throw self.unavailable() }
            return try await self.tts.download(allowCellular: options?["allowCellular"] as? Bool ?? false)
        }
        Function("cancelDownload") { () in
            if #available(iOS 18.0, *) { (self.service as? KokoroService)?.cancelDownload() }
        }
        AsyncFunction("removeModel") { () async throws in
            guard #available(iOS 18.0, *) else { throw self.unavailable() }
            try await self.tts.remove()
        }
        AsyncFunction("load") { (options: [String: Any]?) async throws -> [String: Any] in
            guard #available(iOS 18.0, *) else { throw self.unavailable() }
            let plan = KokoroAneV3ComputePlan(rawValue: options?["units"] as? String ?? "ane") ?? .ane
            let timeout = max(1, (options?["timeoutMs"] as? Double ?? 120_000) / 1000)
            do {
                return try await self.tts.load(lexicon: options?["lexicon"] as? [String: String] ?? [:], plan: plan, timeout: timeout)
            } catch {
                let e = KokoroLoadError.failed(error)
                throw Exception(name: e.code, description: e.message, code: e.code)
            }
        }
        Function("unload") { () in
            if #available(iOS 18.0, *) { (self.service as? KokoroService)?.unload() }
        }
        AsyncFunction("diagnostics") { () async -> [String: Any] in
            guard #available(iOS 18.0, *) else {
                return ["deviceModel": KokoroUtil.deviceModel(), "osVersion": KokoroUtil.osVersion(), "dir": "", "readyMarker": false, "intact": false,
                        "missing": [String](), "files": [[String: Any]](), "bytesOnDisk": 0, "freeBytes": -1, "footprintMB": KokoroUtil.footprintMB(),
                        "protection": "n/a", "excludedFromBackup": false, "aneCacheBytes": -1, "running": [[String: Any]](), "qaFlags": KokoroQA.summary,
                        "log": KokoroLog.recent(50)]
            }
            return await self.tts.diagnostics()
        }
        AsyncFunction("setLexicon") { (entries: [String: String]) async in
            if #available(iOS 18.0, *) { await self.tts.setLexicon(entries) }
        }
        AsyncFunction("phonemes") { (text: String) async throws -> String in
            guard #available(iOS 18.0, *) else { throw self.unavailable() }
            return try await self.tts.phonemes(text)
        }
        AsyncFunction("synthesize") { (text: String, options: [String: Any]?) async throws -> [String: Any] in
            guard #available(iOS 18.0, *) else { throw self.unavailable() }
            return try await self.tts.synthesize(
                text, voice: options?["voice"] as? String ?? "af_heart",
                speed: Float(options?["speed"] as? Double ?? 1), pause: options?["pause"] as? Double ?? 0)
        }
        AsyncFunction("play") { (id: Int, promise: Promise) in
            self.player.play(id) { heard in promise.resolve(heard) }
        }
        Function("stop") { () in self.player.stop() }
        AsyncFunction("writeWav") { (pieces: [String], options: [String: Any]?, path: String) async throws -> [String: Any] in
            guard #available(iOS 18.0, *) else { throw self.unavailable() }
            return try await self.tts.writeWav(
                pieces, pauses: options?["pauses"] as? [Double] ?? [], voice: options?["voice"] as? String ?? "af_heart",
                speed: Float(options?["speed"] as? Double ?? 1), path: path)
        }
        AsyncFunction("writeSystemWav") { (text: String, options: [String: Any]?, path: String) async throws -> [String: Any] in
            try await SystemVoiceWriter.write(
                text, voiceId: options?["voiceId"] as? String, rate: Float(options?["rate"] as? Double ?? 1), path: path)
        }
        OnDestroy {
            self.player.stop()
            if #available(iOS 18.0, *) { (self.service as? KokoroService)?.cancelDownload() }
        }
    }
}

/// Model files, the loaded engine and its diagnostics. An actor: downloads, loads and syntheses never overlap in state.
@available(iOS 18.0, *)
actor KokoroService {
    private let player: KokoroPlayer
    private let emit: (String, [String: Any]) -> Void
    private var store: KokoroModelStore?
    private let loader: KokoroLoader
    private var lexicon: [String: String] = [:]
    private var lastFraction = -1.0

    init(player: KokoroPlayer, emit: @escaping (String, [String: Any]) -> Void) {
        self.player = player
        self.emit = emit
        let send = UncheckedSendableBox(emit)
        loader = KokoroLoader { plan, stage, done, ms in
            send.value("onLoadProgress", ["units": plan.rawValue, "stage": stage, "done": done, "ms": ms])
        }
    }

    nonisolated func status() -> [String: Any] {
        let marker = KokoroModelStore.hasReadyMarker()
        let missing = marker ? KokoroModelStore.missing() : []
        return ["ready": marker && missing.isEmpty, "damaged": marker && !missing.isEmpty, "missing": missing.count,
                "bytesOnDisk": KokoroModelStore.bytesOnDisk(), "downloadBytes": KokoroModelStore.totalBytes,
                "revision": KokoroModelStore.v3Revision, "dir": KokoroModelStore.defaultRoot.path]
    }

    func download(allowCellular: Bool) async throws -> [String: Any] {
        let t0 = Date()
        let s = KokoroModelStore(allowCellular: allowCellular)
        store = s
        lastFraction = -1
        let missing = KokoroModelStore.hasReadyMarker() ? KokoroModelStore.missing() : []
        if !missing.isEmpty { KokoroLog.note("repair: \(missing.count) file(s) missing: \(missing.prefix(6).joined(separator: ", "))") }
        s.progress = { [weak self] fraction, file in
            guard let self else { return }
            Task { await self.progress(fraction, file) }
        }
        defer { Task { await self.clearStore() } }
        do {
            _ = try await s.ensure()
        } catch KokoroModelStore.Failure.cancelled {
            throw Exception(name: "ERR_KOKORO_CANCELLED", description: "Download cancelled.", code: "ERR_KOKORO_CANCELLED")
        } catch KokoroModelStore.Failure.noSpace(let bytes) {
            throw Exception(name: "ERR_KOKORO_NO_SPACE", description: KokoroModelStore.Failure.noSpace(bytes).localizedDescription, code: "ERR_KOKORO_NO_SPACE")
        } catch {
            KokoroLog.note("download failed: \(KokoroAneV3StageError.describe(error))", error: true)
            throw error
        }
        KokoroLog.note("download done in \(Int(Date().timeIntervalSince(t0))) s (\(KokoroModelStore.bytesOnDisk() / 1_000_000) MB on disk)")
        return ["seconds": Date().timeIntervalSince(t0), "dir": s.root.path]
    }

    private func clearStore() { store = nil }

    private func progress(_ fraction: Double, _ file: String) {
        if file == "compiling" { emit("onProgress", ["phase": "compiling", "fraction": 1]); return }
        // At most ~200 events per download.
        guard fraction - lastFraction >= 0.005 || fraction >= 1 else { return }
        lastFraction = fraction
        emit("onProgress", ["phase": "download", "fraction": fraction])
    }

    nonisolated func cancelDownload() {
        Task { await self.cancelStore() }
    }

    private func cancelStore() { store?.cancel() }

    func remove() async throws {
        store?.cancel()
        let g = loader.gate.bump()
        await loader.drop(before: g)
        try KokoroModelStore.removeAll()
        KokoroLog.note("model removed")
    }

    func load(lexicon entries: [String: String], plan: KokoroAneV3ComputePlan, timeout: Double) async throws -> [String: Any] {
        lexicon = entries
        guard KokoroModelStore.isReady() else {
            KokoroLog.note("load \(plan.rawValue): not downloaded (missing: \(KokoroModelStore.missing().count))", error: true)
            throw KokoroLoadError.notDownloaded
        }
        let before = KokoroUtil.footprintMB()
        let r = try await loader.load(root: KokoroModelStore.defaultRoot, lexicon: entries, plan: plan, timeout: timeout)
        return ["seconds": r.loadSeconds, "warmupMs": r.warmupMs, "footprintBeforeMB": before, "footprintAfterMB": KokoroUtil.footprintMB(),
                "alreadyLoaded": r.alreadyLoaded, "adopted": r.adopted, "units": plan.rawValue]
    }

    /// Synchronous on the caller's thread: a load in progress rejects at once with ERR_KOKORO_UNLOADED; the engine goes next.
    nonisolated func unload() {
        let g = loader.gate.bump()
        Task { await self.unloadNow(before: g) }
    }

    private func unloadNow(before g: Int) async {
        await loader.drop(before: g)
    }

    func diagnostics() async -> [String: Any] {
        var d = KokoroModelStore.diagnostics()
        d["deviceModel"] = KokoroUtil.deviceModel()
        d["osVersion"] = KokoroUtil.osVersion()
        d["footprintMB"] = KokoroUtil.footprintMB()
        d["aneCacheBytes"] = Int(KokoroUtil.aneCacheBytes())
        if let units = await loader.engineUnits { d["engineUnits"] = units.rawValue }
        d["running"] = await loader.runningSummary()
        d["qaFlags"] = KokoroQA.summary
        d["log"] = KokoroLog.recent(50)
        return d
    }

    func setLexicon(_ entries: [String: String]) async {
        lexicon = entries
        await loader.engine?.setLexicon(entries)
    }

    private func loaded() async throws -> KokoroEngine {
        guard let engine = await loader.engine else { throw Exception(name: "ERR_KOKORO_NOT_LOADED", description: "The voice model is not loaded.", code: "ERR_KOKORO_NOT_LOADED") }
        return engine
    }

    func phonemes(_ text: String) async throws -> String {
        try await loaded().phonemes(text)
    }

    func synthesize(_ text: String, voice: String, speed: Float, pause: Double) async throws -> [String: Any] {
        let engine = try await loaded()
        let t0 = Date()
        let r = try await engine.synthesize(text, voice: voice, speed: speed)
        let ms = Date().timeIntervalSince(t0) * 1000
        let audio = Double(r.samples.count) / KokoroPlayer.sampleRate
        let peak = KokoroUtil.peak(r.samples)
        ttsLog.info("piece \(voice, privacy: .public) \(Int(ms))ms for \(String(format: "%.2f", audio))s frames=\(r.frames) fast=\(r.fast) peak=\(String(format: "%.3f", peak))")
        // Silence or garbage instead of speech: a Core ML runtime problem; the caller hands over to the system voice.
        if let problem = KokoroQA.audioProblem(r.samples) { throw Exception(name: "ERR_KOKORO_BAD_AUDIO", description: problem, code: "ERR_KOKORO_BAD_AUDIO") }
        let stored = player.store(r.samples, pause: pause)
        return ["id": stored.id, "seconds": stored.seconds, "audioSeconds": audio,
                "synthMs": ms, "frames": r.frames, "fast": r.fast]
    }

    /// QA / samples: the pieces exactly as the player joins them (edge silence trimmed, each piece's pause after it), one WAV.
    func writeWav(_ pieces: [String], pauses: [Double], voice: String, speed: Float, path: String) async throws -> [String: Any] {
        let engine = try await loaded()
        var all: [Float] = []
        var runs: [[String: Any]] = []
        for (i, text) in pieces.enumerated() {
            let t0 = Date()
            let r = try await engine.synthesize(text, voice: voice, speed: speed)
            let ms = Date().timeIntervalSince(t0) * 1000
            all += KokoroPlayer.trim(r.samples)
            all += [Float](repeating: 0, count: Int(max(0, i < pauses.count ? pauses[i] : 0) * KokoroPlayer.sampleRate))
            runs.append(["text": text, "synthMs": ms, "audioSeconds": Double(r.samples.count) / KokoroPlayer.sampleRate, "peak": KokoroUtil.peak(r.samples),
                         "frames": r.frames, "fast": r.fast, "phonemes": r.phonemes, "stageMs": r.stageMs])
        }
        let url = path.hasPrefix("file://") ? URL(string: path)! : URL(fileURLWithPath: path)
        try KokoroUtil.writeWAV(all, sampleRate: Int(KokoroPlayer.sampleRate), to: url)
        return ["seconds": Double(all.count) / KokoroPlayer.sampleRate, "pieces": runs]
    }
}
