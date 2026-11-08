// KokoroLoader.swift: one load of the Kokoro engine with one set of compute units, under a deadline, for the app's fallback
// chain (Neural Engine -> GPU -> CPU, decided in src/services/natural-voice.ts), plus the native log for Settings › Voice ›
// Diagnostics. No Expo here (KokoroTtsModule maps KokoroLoadError to Expo exceptions), so a macOS harness can build it.
//
// Core ML cannot interrupt a model load or an Neural Engine compile. A load that times out, or that the app stops waiting for
// (unload()), keeps running on its own thread until it ends and its result is dropped; a new load with the same compute units
// while it still runs takes it over instead of starting a second one (e.g. the app went to the background and came back).
import CoreML
import Foundation
import os

/// Console (subsystem com.example.phiremote, category tts): one line per load step and per piece, no text.
let ttsLog = Logger(subsystem: "com.example.phiremote", category: "tts")

/// Hands a non-Sendable value (the module's event sender, safe from any thread) to a @Sendable closure.
final class UncheckedSendableBox<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

/// An error the JS side reacts to by code.
struct KokoroLoadError: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { message }

    static func timeout(_ plan: KokoroAneV3ComputePlan, _ seconds: Double) -> KokoroLoadError {
        KokoroLoadError(code: "ERR_KOKORO_LOAD_TIMEOUT", message: "did not load within \(Int(seconds.rounded())) s on the \(plan.label)")
    }
    static let unloaded = KokoroLoadError(code: "ERR_KOKORO_UNLOADED", message: "The voice model was unloaded.")
    static let notDownloaded = KokoroLoadError(code: "ERR_KOKORO_NOT_DOWNLOADED", message: "The voice model is not downloaded.")
    static func badAudio(_ detail: String) -> KokoroLoadError { KokoroLoadError(code: "ERR_KOKORO_BAD_AUDIO", message: detail) }
    static func failed(_ error: Error) -> KokoroLoadError {
        if let e = error as? KokoroLoadError { return e }
        return KokoroLoadError(code: "ERR_KOKORO_LOAD_FAILED", message: KokoroAneV3StageError.describe(error))
    }
}

/// The newest native lines (load steps, attempt outcomes, errors in full), for Settings › Voice › Diagnostics.
enum KokoroLog {
    private static let lock = NSLock()
    private static var lines: [String] = []
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    static func note(_ text: String, error: Bool = false) {
        if error { ttsLog.error("\(text, privacy: .public)") } else { ttsLog.info("\(text, privacy: .public)") }
        lock.lock()
        lines.append("\(formatter.string(from: Date())) \(text)")
        if lines.count > 100 { lines.removeFirst(lines.count - 100) }
        lock.unlock()
    }

    static func recent(_ n: Int) -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return Array(lines.suffix(n))
    }
}

/// Simulator / QA launch arguments (iOS puts `-key value` in UserDefaults' argument domain; TestFlight and App Store installs
/// never have them):
///   -phiTtsForceFail ane,gpu      those compute units fail at once
///   -phiTtsForceHang ane          those never finish (exercises the timeout)
///   -phiTtsForceBadAudio ane      those make "no sound" at the warm-up
///   -phiTtsAcceptAnyAudio 1       keep a model whatever audio it makes (the iOS Simulator's Core ML returns silence for this
///                                 model with every compute unit, so this is how the Simulator exercises the read path)
enum KokoroQA {
    static let keys = ["phiTtsForceFail", "phiTtsForceHang", "phiTtsForceBadAudio", "phiTtsAcceptAnyAudio"]

    static var acceptAnyAudio: Bool { UserDefaults.standard.string(forKey: "phiTtsAcceptAnyAudio") == "1" }

    /// What is wrong with the samples (nil = speech), unless QA accepts any audio.
    static func audioProblem(_ samples: [Float]) -> String? {
        acceptAnyAudio ? nil : KokoroUtil.audioProblem(samples)
    }

    static func has(_ key: String, _ plan: KokoroAneV3ComputePlan) -> Bool {
        guard let v = UserDefaults.standard.string(forKey: key) else { return false }
        return v.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.contains(plan.rawValue)
    }

    static var summary: String {
        keys.compactMap { k in UserDefaults.standard.string(forKey: k).map { "\(k)=\($0)" } }.joined(separator: " ")
    }
}

/// A continuation resumed once, by whichever comes first: the load, its deadline, or unload().
final class KokoroOnce<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var cont: CheckedContinuation<T, Error>?
    private var early: Result<T, Error>?
    private var done = false

    func wait() async throws -> T {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<T, Error>) in
            lock.lock()
            if let early {
                self.early = nil
                lock.unlock()
                c.resume(with: early)
                return
            }
            cont = c
            lock.unlock()
        }
    }

    func resume(_ r: Result<T, Error>) {
        lock.lock()
        if done { lock.unlock(); return }
        done = true
        if let c = cont {
            cont = nil
            lock.unlock()
            c.resume(with: r)
        } else {
            early = r
            lock.unlock()
        }
    }
}

/// unload() bumps the generation and wakes every load waiting, at once and on the caller's thread (so a load() right after an
/// unload() never sees the old generation).
final class KokoroGate<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var gen = 0
    private var waiters: [ObjectIdentifier: KokoroOnce<T>] = [:]

    var generation: Int {
        lock.lock()
        defer { lock.unlock() }
        return gen
    }

    /// Registers a waiter for generation `g`; false (and the waiter woken with `unloaded`) when an unload came first.
    @discardableResult
    func add(_ once: KokoroOnce<T>, generation g: Int) -> Bool {
        lock.lock()
        guard g == gen else {
            lock.unlock()
            once.resume(.failure(KokoroLoadError.unloaded))
            return false
        }
        waiters[ObjectIdentifier(once)] = once
        lock.unlock()
        return true
    }

    func remove(_ once: KokoroOnce<T>) {
        lock.lock()
        waiters[ObjectIdentifier(once)] = nil
        lock.unlock()
    }

    /// The new generation.
    func bump() -> Int {
        lock.lock()
        gen += 1
        let g = gen
        let woken = Array(waiters.values)
        waiters = [:]
        lock.unlock()
        for w in woken { w.resume(.failure(KokoroLoadError.unloaded)) }
        return g
    }
}

/// One load with one set of compute units: Core ML stages, G2P, lexicon, then one warm-up piece per synthesis path (the short
/// and the long static decoder and the general vocoder), each checked for real speech.
@available(iOS 18.0, macOS 15.0, *)
final class KokoroLoadAttempt: @unchecked Sendable {
    struct Loaded: @unchecked Sendable {
        let engine: KokoroEngine
        let loadSeconds: Double
        let warmupMs: Double
    }

    static let warmups = [
        "Hello there, this is a test.",
        "This sentence is a little longer, so it takes the second decoder size.",
        "And this one is long enough to need the general vocoder, the path that longer sentences in a reply take every day.",
    ]

    let plan: KokoroAneV3ComputePlan
    let started = Date()
    let deadline: Date
    let timeout: Double
    private let lock = NSLock()
    private var outcome: Result<Loaded, Error>?
    private var observers: [(Result<Loaded, Error>) -> Void] = []
    private var timedOutValue = false
    private var abandonedValue = false

    init(plan: KokoroAneV3ComputePlan, timeout: Double) {
        self.plan = plan
        self.timeout = timeout
        deadline = started.addingTimeInterval(timeout)
    }

    var finished: Bool { lock.lock(); defer { lock.unlock() }; return outcome != nil }
    var timedOut: Bool { lock.lock(); defer { lock.unlock() }; return timedOutValue }
    var abandoned: Bool { lock.lock(); defer { lock.unlock() }; return abandonedValue }
    func markTimedOut() { lock.lock(); if outcome == nil { timedOutValue = true }; lock.unlock() }
    func markAbandoned() { lock.lock(); if outcome == nil { abandonedValue = true }; lock.unlock() }

    func start(root: URL, lexicon: [String: String], onStage: @escaping @Sendable (String, Bool, Double) -> Void) {
        let plan = self.plan
        Task.detached(priority: .userInitiated) { [self] in
            let r: Result<Loaded, Error>
            do {
                r = .success(try await KokoroLoadAttempt.run(plan: plan, root: root, lexicon: lexicon, onStage: onStage))
            } catch {
                r = .failure(error)
            }
            finish(r)
        }
    }

    /// `fn` runs once with the outcome (at once when it is already known).
    func observe(_ fn: @escaping (Result<Loaded, Error>) -> Void) {
        lock.lock()
        if let outcome {
            lock.unlock()
            fn(outcome)
            return
        }
        observers.append(fn)
        lock.unlock()
    }

    private func finish(_ r: Result<Loaded, Error>) {
        lock.lock()
        outcome = r
        let obs = observers
        observers = []
        lock.unlock()
        for o in obs { o(r) }
    }

    static func run(plan: KokoroAneV3ComputePlan, root: URL, lexicon: [String: String],
                    onStage: @escaping @Sendable (String, Bool, Double) -> Void) async throws -> Loaded {
        if KokoroQA.has("phiTtsForceHang", plan) {
            KokoroLog.note("QA: the \(plan.label) load hangs (-phiTtsForceHang)")
            onStage("QA hang", false, 0)
            while true { try await Task.sleep(nanoseconds: 3_600_000_000_000) }
        }
        if KokoroQA.has("phiTtsForceFail", plan) {
            throw KokoroLoadError(code: "ERR_KOKORO_LOAD_FAILED", message: "forced failure on the \(plan.label) (QA)")
        }
        let t0 = Date()
        let engine: KokoroEngine
        do {
            engine = try await KokoroEngine.load(root: root, lexicon: lexicon, plan: plan, onStage: onStage)
        } catch {
            throw KokoroLoadError.failed(error)
        }
        let loadSeconds = Date().timeIntervalSince(t0)
        // A model that loads but does not make speech on this device (silence or garbage: Core ML mis-ran it) is not kept.
        let w0 = Date()
        for (i, text) in warmups.enumerated() {
            let stage = "warm-up \(i + 1)"
            onStage(stage, false, 0)
            let s0 = DispatchTime.now().uptimeNanoseconds
            let r: KokoroEngine.Synthesis
            do {
                r = try await engine.synthesize(text, voice: "af_heart", speed: 1)
            } catch {
                throw KokoroLoadError(code: "ERR_KOKORO_LOAD_FAILED", message: "\(stage) (\(plan.label)): \(KokoroAneV3StageError.describe(error))")
            }
            onStage(stage, true, Double(DispatchTime.now().uptimeNanoseconds - s0) / 1e6)
            let problem = KokoroQA.has("phiTtsForceBadAudio", plan) ? "no sound (QA)" : KokoroQA.audioProblem(r.samples)
            if let problem {
                throw KokoroLoadError.badAudio("\(stage) on the \(plan.label) (\(r.frames) frames, peak \(String(format: "%.3f", KokoroUtil.peak(r.samples)))): \(problem)")
            }
        }
        return Loaded(engine: engine, loadSeconds: loadSeconds, warmupMs: Date().timeIntervalSince(w0) * 1000)
    }
}

/// The loaded engine, the load attempts and their waiters: what KokoroService (the Expo module's actor) delegates loading to.
@available(iOS 18.0, macOS 15.0, *)
actor KokoroLoader {
    typealias Loaded = KokoroLoadAttempt.Loaded

    let gate = KokoroGate<Loaded>()
    private(set) var engine: KokoroEngine?
    private(set) var engineUnits: KokoroAneV3ComputePlan?
    private var engineGeneration = 0
    private(set) var running: [KokoroLoadAttempt] = []
    private let onStage: @Sendable (KokoroAneV3ComputePlan, String, Bool, Double) -> Void

    init(onStage: @escaping @Sendable (KokoroAneV3ComputePlan, String, Bool, Double) -> Void = { _, _, _, _ in }) {
        self.onStage = onStage
    }

    struct Result {
        let engine: KokoroEngine
        let loadSeconds: Double
        let warmupMs: Double
        let alreadyLoaded: Bool
        let adopted: Bool
    }

    /// Loads with `plan` within `timeout` seconds of the attempt's start. Throws KokoroLoadError (timeout, unloaded, bad audio,
    /// failed). A loaded engine with other compute units is dropped first.
    func load(root: URL, lexicon: [String: String], plan: KokoroAneV3ComputePlan, timeout: Double) async throws -> Result {
        if let engine, engineUnits == plan {
            await engine.setLexicon(lexicon)
            return Result(engine: engine, loadSeconds: 0, warmupMs: 0, alreadyLoaded: true, adopted: false)
        }
        if engine != nil {
            KokoroLog.note("dropping the \(engineUnits?.label ?? "?") engine for a \(plan.label) load")
            engine = nil
            engineUnits = nil
        }
        let gen = gate.generation
        let attempt: KokoroLoadAttempt
        let adopted: Bool
        if let a = running.first(where: { $0.plan == plan && !$0.finished && !$0.timedOut }) {
            attempt = a
            adopted = true
            KokoroLog.note("load \(plan.rawValue): continuing the attempt started \(Int(-a.started.timeIntervalSinceNow)) s ago")
        } else {
            attempt = KokoroLoadAttempt(plan: plan, timeout: timeout)
            adopted = false
            running.append(attempt)
            KokoroLog.note("load \(plan.rawValue): start (timeout \(Int(timeout)) s, app memory \(Int(KokoroUtil.footprintMB())) MB)")
            let report = onStage
            attempt.start(root: root, lexicon: lexicon) { stage, done, ms in
                report(plan, stage, done, ms)
                if done && ms >= 500 { KokoroLog.note("load \(plan.rawValue): \(stage) \(Int(ms)) ms") }
            }
            attempt.observe { [weak self] r in
                Task { await self?.ended(attempt, r) }
            }
        }
        let once = KokoroOnce<Loaded>()
        guard gate.add(once, generation: gen) else { throw KokoroLoadError.unloaded }
        defer { gate.remove(once) }
        attempt.observe { once.resume($0) }
        let remaining = max(0.05, attempt.deadline.timeIntervalSinceNow)
        let limit = attempt.timeout
        let timer = Task {
            do { try await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000)) } catch { return }
            attempt.markTimedOut()
            once.resume(.failure(KokoroLoadError.timeout(plan, limit)))
        }
        defer { timer.cancel() }
        let loaded: Loaded
        do {
            loaded = try await once.wait()
        } catch {
            let e = KokoroLoadError.failed(error)
            if e.code == "ERR_KOKORO_UNLOADED" { attempt.markAbandoned() }
            KokoroLog.note("load \(plan.rawValue): \(e.code) \(e.message) after \(String(format: "%.1f", -attempt.started.timeIntervalSinceNow)) s",
                           error: e.code != "ERR_KOKORO_UNLOADED")
            throw e
        }
        guard gen == gate.generation else {
            attempt.markAbandoned()
            throw KokoroLoadError.unloaded
        }
        engine = loaded.engine
        engineUnits = plan
        engineGeneration = gen
        KokoroLog.note("load \(plan.rawValue): loaded in \(String(format: "%.2f", loaded.loadSeconds)) s, warm-up \(Int(loaded.warmupMs)) ms, app memory \(Int(KokoroUtil.footprintMB())) MB\(adopted ? " (continued)" : "")")
        return Result(engine: loaded.engine, loadSeconds: loaded.loadSeconds, warmupMs: loaded.warmupMs, alreadyLoaded: false, adopted: adopted)
    }

    private func ended(_ attempt: KokoroLoadAttempt, _ r: Swift.Result<Loaded, Error>) {
        running.removeAll { $0 === attempt }
        guard attempt.timedOut || attempt.abandoned else { return }
        // Nobody waits for it any more: say how it ended, and let its engine go.
        let secs = String(format: "%.1f", -attempt.started.timeIntervalSinceNow)
        switch r {
        case .success: KokoroLog.note("load \(attempt.plan.rawValue): the dropped attempt finished after \(secs) s (not kept)")
        case .failure(let e): KokoroLog.note("load \(attempt.plan.rawValue): the dropped attempt ended after \(secs) s: \(KokoroAneV3StageError.describe(e))")
        }
    }

    /// Frees the engine (unless a newer load replaced it) — called after `gate.bump()` returned `generation`.
    func drop(before generation: Int) {
        guard engine != nil, engineGeneration < generation else { return }
        engine = nil
        engineUnits = nil
        KokoroLog.note("unloaded")
    }

    /// Diagnostics: the attempts still running.
    func runningSummary() -> [[String: Any]] {
        running.map { ["units": $0.plan.rawValue, "seconds": -$0.started.timeIntervalSinceNow, "timedOut": $0.timedOut, "abandoned": $0.abandoned] }
    }
}
