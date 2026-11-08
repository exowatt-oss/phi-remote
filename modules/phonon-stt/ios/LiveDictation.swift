// LiveDictation.swift: live ("as you speak") dictation on top of PhononCoreML's offline Transcriber.
// The SAME file is compiled into the macOS bench (bench/Sources/PhononLive) and the iOS Expo module (modules/phonon-stt/ios).
//
// Phonon-2 is an offline TDT model: it reads a whole utterance at once. Live text comes from re-reading the OPEN utterance (the
// speech since the last commit) every `updateInterval` seconds with the smallest encoder function that holds it (5 / 10 / 15 s).
// Committed text is never decoded again, so one update costs at most one read of <= maxTailSeconds of audio.
//   pause commit  : speech followed by >= pauseCommitSeconds of quiet (anywhere in the tail, so a late update still finds it) is
//                   read on its own, with 0.3 s of quiet either side, and committed
//   missing words : a run of >= 1.2 s of speech no word covers (TDT sometimes stops emitting after a sentence end; Phonon's long-
//                   audio path re-decodes such windows) -> the words before it are committed and the rest is read again at once
//   forced cut    : an open utterance longer than maxTailSeconds is cut after the latest sentence end (else clause end, else the
//                   quietest word boundary) that has >= cutKeepSeconds of audio after it; the words before the cut are committed
//   quiet test    : the Phonon reference engines' gate: RMS over 50 ms blocks, gate = max(0.004, 0.18 x peak)
// Thread-safety: `append` may be called from any thread (an audio tap); `update`, `finish` and `fullPass` are serialised.
import Accelerate
import Foundation
#if canImport(PhononCoreML)
import PhononCoreML
#endif

public struct LiveWord: Codable, Equatable {
    public let text: String
    public let start: Double   // seconds since the start of the recording
    public let end: Double
}

public struct LiveUpdate {
    public enum Kind: String { case partial, pauseCommit = "commit-pause", cutCommit = "commit-cut", final }
    public var kind: Kind
    public var committed: String          // stable text: never changes again
    public var tail: String               // the current utterance: may still change on the next update
    public var tailWords: [LiveWord]
    public var audioSeconds: Double       // audio received when this update started
    public var decodedSeconds: Double     // length of the audio this update read
    public var function: Int              // encoder function used (5 / 10 / 15 s); 0 = nothing decoded
    public var decodeMs: Double
    public var text: String { committed.isEmpty ? tail : (tail.isEmpty ? committed : committed + " " + tail) }
}

@available(iOS 18.0, macOS 15.0, *)
public final class LiveDictation {
    public struct Config {
        public var updateInterval = 0.4          // seconds between re-reads of the tail
        public var minNewAudioSeconds = 0.15     // skip an update when less new audio arrived since the last one
        public var pauseCommitSeconds = 0.6      // quiet after speech that commits the tail
        public var maxTailSeconds = 12.0         // a longer open utterance is cut after a sentence end (lowered to fit the loaded functions)
        public var cutKeepSeconds = 2.5          // a forced cut never commits words from the newest cutKeepSeconds of audio
        public var hardMaxSeconds = 14.8         // never more than this to the encoder in one update (the 15 s function)
        public var leadInSeconds = 0.3           // quiet kept in front of speech
        public var contextSeconds = 2.0          // audio before an utterance read with it, for its first word's case and the previous
                                                 // word's punctuation (a pause commit otherwise reads "potatoes. and fat mutton")
        public var noiseFloorRMS: Float = 0.004
        public var gateRatio: Float = 0.18
        public init() {}
    }
    public static let sampleRate = 16000
    static let block = 800                       // 50 ms

    public let transcriber: Transcriber
    public let config: Config
    let keepAll: Bool
    let lock = NSLock()                          // audio buffers
    let work = NSLock()                          // update / finish / fullPass
    var tail: [Float] = []
    var tailStart = 0                            // absolute sample index of tail[0]
    var received = 0
    var all: [Float] = []
    var lastUpdateAt = Int.min / 2
    var committedWords: [LiveWord] = []
    var committedText = ""
    var sessionPeak: Float = 0
    var carryCase: String? = nil
    public private(set) var contextRetries = 0
    public private(set) var updates = 0
    public var debug: ((String) -> Void)? = nil   // diagnostics (bench: PHONON_DEBUG=1)

    public init(transcriber: Transcriber, config: Config = Config(), keepAllAudio: Bool = true) {
        self.transcriber = transcriber; self.config = config; keepAll = keepAllAudio
    }

    /// Mono 16 kHz samples, from any thread.
    public func append(_ samples: [Float]) {
        lock.lock(); tail.append(contentsOf: samples); received += samples.count; if keepAll { all.append(contentsOf: samples) }; lock.unlock()
    }
    public var audioSeconds: Double { lock.lock(); defer { lock.unlock() }; return Double(received) / Double(LiveDictation.sampleRate) }
    public var words: [LiveWord] { work.lock(); defer { work.unlock() }; return committedWords }

    static func blockRMS(_ x: ArraySlice<Float>) -> [Float] {
        let nb = x.count / block
        var out = [Float](repeating: 0, count: nb)
        x.withUnsafeBufferPointer { p in for b in 0..<nb { vDSP_rmsqv(p.baseAddress! + b * block, 1, &out[b], vDSP_Length(block)) } }
        return out
    }
    func gate(_ rms: [Float]) -> Float { max(config.noiseFloorRMS, config.gateRatio * max(rms.max() ?? 0, 0.5 * sessionPeak)) }
    func dropPrefix(_ n: Int) {
        guard n > 0 else { return }
        lock.lock(); let k = min(n, tail.count); tail.removeFirst(k); tailStart += k; lock.unlock()
    }
    /// The longest read the loaded functions hold (14.8 s with the 15 s function, 9.8 s with only the 10 s one).
    var readCap: Double { min(config.hardMaxSeconds, (transcriber.functionSeconds.last ?? 15) - 0.2) }
    /// maxTailSeconds, lowered so an open utterance plus its context still fits one read (7.5 s with only the 10 s function).
    var maxTail: Double { min(config.maxTailSeconds, readCap - config.contextSeconds - 0.3) }
    /// The encoder function Transcriber picks for `n` samples (the smallest that holds n/160 frames + 20 ms).
    public func function(forSamples n: Int) -> Int {
        let sec = Double(n / 160) * 0.01 + 0.02
        return Int(transcriber.functionSeconds.first(where: { $0 >= sec }) ?? 0)
    }
    func decode(_ x: ArraySlice<Float>, at absStart: Int) throws -> ([LiveWord], Double) {
        let t0 = Date()
        let t = try transcriber.transcribe(Array(x))
        let off = Double(absStart) / Double(LiveDictation.sampleRate)
        return (t.words.map { LiveWord(text: $0.text, start: $0.start + off, end: $0.end + off) }, Date().timeIntervalSince(t0) * 1000)
    }
    /// Read samples [absStart, absEnd) with up to contextSeconds of the recording before them. Words that start in the context are
    /// dropped, except that the last one corrects the punctuation / case of the last committed word when it is the same word.
    func decodeInContext(_ x: ArraySlice<Float>, at absStart: Int) throws -> ([LiveWord], Double) {
        let ctx = Int(config.contextSeconds * Double(LiveDictation.sampleRate))
        guard keepAll, ctx > 0, absStart > 0, !committedWords.isEmpty else { return try decode(x, at: absStart) }
        let c0 = max(0, absStart - ctx)
        lock.lock(); let pre = c0 < absStart && absStart <= all.count ? Array(all[c0..<absStart]) : []; lock.unlock()
        guard !pre.isEmpty else { return try decode(x, at: absStart) }
        let (ws, ms) = try decode((pre + Array(x))[...], at: c0)
        // context = words that start before the boundary; one starting just before it (word starts are good to an 80 ms frame) is
        // context only if it repeats the last committed word
        let b = Double(absStart) / Double(LiveDictation.sampleRate), lastBare = committedWords.last.map { LiveDictation.bare($0.text) }
        let isCtx: (LiveWord) -> Bool = { w in w.start < b - 0.25 || (w.start < b - 0.04 && LiveDictation.bare(w.text) == lastBare) }
        let inCtx = ws.filter(isCtx), mine = ws.filter { !isCtx($0) }
        if let lc = inCtx.last, let last = committedWords.last, lc.text != last.text,
           LiveDictation.bare(lc.text) == LiveDictation.bare(last.text) {
            committedWords[committedWords.count - 1] = LiveWord(text: lc.text, start: last.start, end: last.end)
            committedText = LiveDictation.joined(committedWords)
        }
        return (mine, ms)
    }
    static func bare(_ s: String) -> String { s.lowercased().trimmingCharacters(in: .punctuationCharacters) }
    func commit<S: Sequence>(_ ws: S) where S.Element == LiveWord {
        let ws = Array(ws); guard !ws.isEmpty else { return }
        committedWords.append(contentsOf: ws)
        let s = ws.map(\.text).joined(separator: " ")
        committedText = committedText.isEmpty ? s : committedText + " " + s
    }
    static func joined(_ ws: [LiveWord]) -> String { ws.map(\.text).joined(separator: " ") }

    static let sentenceEnd: Set<Character> = [".", "?", "!"], clauseEnd: Set<Character> = [",", ";", ":"]

    /// Where to cut an over-long open utterance: the latest word boundary that starts at least cutKeepSeconds before the newest
    /// audio, after a sentence end if there is one, else after a clause end, else the quietest boundary. The cut itself is the
    /// quietest 50 ms block just before the next word (TDT word ends are short; starts are good to one 80 ms frame).
    /// Returns the index of the first word that stays open and the cut as a block index of `rms`.
    func cutPoint(_ ws: [LiveWord], rms: [Float], t0: Double, endT: Double, minBlock: Int) -> (word: Int, block: Int)? {
        let limit = endT - config.cutKeepSeconds
        let idx = (1..<max(1, ws.count)).filter { ws[$0].start <= limit }
        guard !idx.isEmpty else { return nil }
        func window(_ i: Int) -> ClosedRange<Int> {
            let z = min(rms.count - 1, Int(((ws[i].start - t0) / 0.05).rounded(.down)))
            let a = min(z, max(minBlock + 1, Int(((ws[i - 1].start - t0) / 0.05).rounded(.down)) + 2, Int(((ws[i - 1].end - t0) / 0.05).rounded(.down)) - 1))
            return max(minBlock + 1, a)...max(minBlock + 1, z)
        }
        func quietest(_ r: ClosedRange<Int>) -> (Int, Float) {
            var best = (r.upperBound, Float.greatestFiniteMagnitude)
            for k in r where k < rms.count && rms[k] <= best.1 { best = (k, rms[k]) }
            return best
        }
        let pick = idx.last(where: { ws[$0 - 1].text.last.map(LiveDictation.sentenceEnd.contains) ?? false })
            ?? idx.last(where: { ws[$0 - 1].text.last.map(LiveDictation.clauseEnd.contains) ?? false })
            ?? idx.min(by: { quietest(window($0)).1 < quietest(window($1)).1 })!
        let cut = quietest(window(pick)).0
        return cut > minBlock ? (pick, cut) : nil
    }

    /// The longest run of speech that no word covers (TDT can drop the words after a sentence end: Phonon's long-audio path re-decodes
    /// such windows). Returns the first word after the run's start and a cut just before the run, when the run holds >= 1.2 s of speech.
    func uncoveredRun(_ ws: [LiveWord], rms: [Float], gate g: Float, t0: Double, from: Int, to last: Int) -> (word: Int, block: Int)? {
        guard !ws.isEmpty, last > from, let r = longestUncovered(ws, rms: rms, gate: g, t0: t0, from: from, to: last), r.speech >= 24 else { return nil }
        let word = ws.firstIndex(where: { $0.start >= t0 + Double(r.start) * 0.05 - 0.1 }) ?? ws.count
        guard word >= 1 else { return nil }
        var cut = r.start, v = Float.greatestFiniteMagnitude
        for b in max(from + 1, r.start - 6)...max(from + 1, r.start) where b < rms.count && rms[b] < v { v = rms[b]; cut = b }
        return cut > from ? (word, cut) : nil
    }
    /// The run of blocks in [from, last] that no word covers (words widened by 2-3 blocks) holding the most speech blocks.
    func longestUncovered(_ ws: [LiveWord], rms: [Float], gate g: Float, t0: Double, from: Int, to last: Int) -> (start: Int, speech: Int)? {
        guard last >= from, last < rms.count else { return nil }
        var covered = [Bool](repeating: false, count: rms.count)
        for w in ws {
            let a = max(from, Int(((w.start - t0) / 0.05).rounded(.down)) - 2), b = min(last + 1, Int(((w.end - t0) / 0.05).rounded(.up)) + 3)
            if a < b { for k in a..<b { covered[k] = true } }
        }
        var best: (start: Int, speech: Int)? = nil
        var k = from
        while k <= last {
            if covered[k] { k += 1; continue }
            var j = k, sp = 0
            while j <= last && !covered[j] { if rms[j] > g { sp += 1 }; j += 1 }
            if best == nil || sp > best!.speech { best = (k, sp) }
            k = j
        }
        return best
    }

    /// A word that was lower case before a forced cut keeps its case when the next read starts a new "sentence" with it.
    func fixCase(_ ws: [LiveWord]) -> [LiveWord] {
        guard let c = carryCase, let f = ws.first, let ch = f.text.first, ch.isUppercase,
              f.text.lowercased().trimmingCharacters(in: .punctuationCharacters) == c else { return ws }
        var out = ws; out[0] = LiveWord(text: ch.lowercased() + f.text.dropFirst(), start: f.start, end: f.end); return out
    }
    func commitOpen(_ ws: ArraySlice<LiveWord>) { commit(fixCase(Array(ws))); carryCase = nil }
    func setCarry(_ w: LiveWord) {
        let ends = committedText.last.map(LiveDictation.sentenceEnd.contains) ?? true
        carryCase = (!ends && (w.text.first?.isLowercase ?? false)) ? w.text.lowercased().trimmingCharacters(in: .punctuationCharacters) : nil
    }

    /// One live step: re-read the open utterance, commit what is final. nil when too little new audio arrived.
    @discardableResult public func update() throws -> LiveUpdate? {
        work.lock(); defer { work.unlock() }
        lock.lock(); let snap = tail; let start = tailStart; let rec = received; lock.unlock()
        if rec - lastUpdateAt < Int(config.minNewAudioSeconds * Double(LiveDictation.sampleRate)) { return nil }
        lastUpdateAt = rec
        return try step(snap, start: start, received: rec, final: false)
    }

    /// End of dictation: read what is left (any length) and commit it.
    public func finish() throws -> LiveUpdate {
        work.lock(); defer { work.unlock() }
        lock.lock(); let snap = tail; let start = tailStart; let rec = received; lock.unlock()
        return try step(snap, start: start, received: rec, final: true)!
    }

    /// The tail = snap (absolute sample `start`). 1) every utterance that ends in a pause >= pauseCommitSeconds is read on its own and
    /// committed; 2) the open utterance (speech after the last pause, trailing quiet trimmed to the lead-in) is read; if words are
    /// missing in it (an uncovered speech run) the part before is committed and the rest read again; if it is longer than
    /// maxTailSeconds it is cut after the latest sentence end with cutKeepSeconds of right context. On `final` everything is committed.
    func step(_ snap: [Float], start: Int, received rec: Int, final: Bool) throws -> LiveUpdate? {
        let sr = LiveDictation.sampleRate, B = LiveDictation.block, srD = Double(sr)
        let rms = LiveDictation.blockRMS(snap[...])
        let g = gate(rms)
        sessionPeak = max(sessionPeak, rms.max() ?? 0)
        let lead = Int((config.leadInSeconds / 0.05).rounded()), pauseBlocks = Int((config.pauseCommitSeconds / 0.05).rounded())
        let t0 = Double(start) / srD
        var kind = LiveUpdate.Kind.partial, ms = 0.0, fn = 0, decoded = 0
        func read(_ a: Int, _ b: Int) throws -> [LiveWord] {   // samples [a, b) of snap
            var (ws, t) = try decodeInContext(snap[a..<b], at: start + a); ms += t; decoded = b - a
            // with context TDT sometimes emits nothing after the context's sentence end: then read the utterance on its own
            let lastBlock = min(rms.count, b / B) - 1
            if !committedWords.isEmpty, let u = longestUncovered(ws, rms: rms, gate: g, t0: t0, from: a / B, to: lastBlock), u.speech >= 24 {
                let (w2, t2) = try decode(snap[a..<b], at: start + a); ms += t2; contextRetries += 1
                if w2.count > ws.count { ws = w2 }
            }
            fn = function(forSamples: b - a + (committedWords.isEmpty ? 0 : min(start + a, Int(config.contextSeconds * srD)))); return ws
        }
        // 1) utterances closed by a pause
        var pos = 0
        while let first = rms[pos...].firstIndex(where: { $0 > g }) {
            var k = first, run = -1
            var pause: (Int, Int)? = nil
            while k < rms.count {
                if rms[k] <= g {
                    if run < 0 { run = k }
                    if k - run + 1 >= pauseBlocks { var e = k; while e < rms.count && rms[e] <= g { e += 1 }; pause = (run, e); break }
                } else { run = -1 }
                k += 1
            }
            guard let (ps, pe) = pause else { break }
            let s = max(pos, first - lead), e = min(ps + lead, rms.count)
            commitOpen(try read(s * B, e * B)[...]); kind = .pauseCommit
            pos = max(e, pe - lead)
        }
        if rms[pos...].firstIndex(where: { $0 > g }) == nil { pos = max(pos, rms.count - lead) }   // only quiet left: keep its lead-in
        // 2) the open utterance
        var tailWords: [LiveWord] = []
        var open = pos
        var guardSteps = 0
        while let first = rms[open...].firstIndex(where: { $0 > g }), guardSteps < 8 {
            guardSteps += 1
            open = max(open, first - lead)
            let lastSpeech = rms[open...].lastIndex(where: { $0 > g })!
            let end = (lastSpeech + 1 + lead) >= rms.count ? snap.count : (lastSpeech + 1 + lead) * B
            // the longest read the loaded functions hold (14.8 s with the 15 s function, 9.8 s with only the 10 s one), minus context
            let hard = Int((readCap - config.contextSeconds) * srD) / B * B
            if end - open * B > hard {   // fell behind (or final on a long tail): commit the oldest part, cut at its quietest block
                let lo = open + max(1, (hard - 5 * sr) / B), hi = open + hard / B
                var cut = hi, v = Float.greatestFiniteMagnitude
                for b in lo..<hi where rms[b] < v { v = rms[b]; cut = b }
                commitOpen(try read(open * B, cut * B)[...]); kind = .cutCommit; open = cut; continue
            }
            let ws = fixCase(try read(open * B, end))
            if let d = debug {
                d(String(format: "open %.2f-%.2f last %.2f g %.4f | ", t0 + Double(open) * 0.05, t0 + Double(end) / srD, t0 + Double(lastSpeech + 1) * 0.05, g)
                  + ws.map { String(format: "%@[%.2f-%.2f]", $0.text, $0.start, $0.end) }.joined(separator: " "))
            }
            if let r = uncoveredRun(ws, rms: rms, gate: g, t0: t0, from: open, to: lastSpeech) {
                commitOpen(ws[..<r.word]); kind = .cutCommit; open = r.block; continue
            }
            if !final, Double(end - open * B) / srD >= maxTail,
               let c = cutPoint(ws, rms: rms, t0: t0, endT: t0 + Double(end) / srD, minBlock: open) {
                commitOpen(ws[..<c.word]); setCarry(ws[c.word]); kind = .cutCommit
                tailWords = Array(ws[c.word...]); open = c.block; break
            }
            tailWords = ws; break
        }
        if final { commitOpen(tailWords[...]); tailWords = []; dropPrefix(snap.count) } else { dropPrefix(open * B) }
        if kind == .partial && tailWords.isEmpty && !final && decoded == 0 { return nil }
        updates += 1
        return LiveUpdate(kind: final ? .final : kind, committed: committedText, tail: LiveDictation.joined(tailWords), tailWords: tailWords,
                          audioSeconds: Double(rec) / srD, decodedSeconds: Double(decoded) / srD, function: fn, decodeMs: ms)
    }

    /// Optional ✓ pass: the whole recording read again offline (Transcriber cuts long audio into 15 s windows at pauses).
    public func fullPass() throws -> (text: String, words: [LiveWord], ms: Double) {
        work.lock(); defer { work.unlock() }
        lock.lock(); let a = all; lock.unlock()
        guard !a.isEmpty else { return ("", [], 0) }
        let (ws, ms) = try decode(a[...], at: 0)
        return (LiveDictation.joined(ws), ws, ms)
    }
}

/// The live loop: a timer re-reads the tail every `updateInterval` on one serial queue (a slow update delays the next one; ticks
/// never pile up), and `stop` waits for an update in flight before the final read.
@available(iOS 18.0, macOS 15.0, *)
public final class LiveSession {
    public let engine: LiveDictation
    public let queue = DispatchQueue(label: "phonon.live", qos: .userInitiated)
    var timer: DispatchSourceTimer?
    public var onUpdate: ((LiveUpdate) -> Void)?
    public var onError: ((Error) -> Void)?

    public init(engine: LiveDictation) { self.engine = engine }
    public func append(_ samples: [Float]) { engine.append(samples) }
    public func start() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        let ms = Int(engine.config.updateInterval * 1000)
        t.schedule(deadline: .now() + .milliseconds(ms), repeating: .milliseconds(ms), leeway: .milliseconds(10))
        t.setEventHandler { [weak self] in self?.tick() }
        timer = t; t.resume()
    }
    func tick() {
        do { if let u = try engine.update() { onUpdate?(u) } } catch { onError?(error) }
    }
    /// Stop the timer, wait for an update in flight, read the rest of the tail.
    public func stop() throws -> LiveUpdate {
        timer?.cancel(); timer = nil
        return try queue.sync { try engine.finish() }
    }
    public func cancel() { timer?.cancel(); timer = nil }
}
