// KokoroEngine.swift: the loaded Kokoro-82M model and its English text front end, as FluidAudio's KokoroAneManager wires
// them for `version: .v3` (English): written-form normalization -> Misaki lexicon (with phi remote's pronunciations
// first) -> per-word BART G2P for unknown words -> Kokoro vocab ids -> the voice pack row for that length -> the ANE-v3
// pipeline (static Albert/decoder buckets on the Neural Engine, generator on the GPU, source DSP on the CPU; longer
// pieces fall back to the original vocoder inside the pipeline). Output: 24 kHz mono float samples.
import CoreML
import Foundation

@available(iOS 18.0, macOS 15.0, *)
actor KokoroEngine {
    struct Synthesis {
        let samples: [Float]
        let frames: Int
        let fast: Bool
        let phonemes: String
        let stageMs: [String: Double]
    }

    let root: URL
    private let pipeline: KokoroAneV3Pipeline
    private let vocab: KokoroAneVocab
    private let g2p: G2PModel
    private let wordMaps: (word: [String: [String]], caseSensitive: [String: [String]])
    private let punctuation: Set<Character>
    private var lexicon: [String: String]
    private var phonemizer: KokoroAneEnglishPhonemizer
    private var voices: [String: KokoroAneVoicePack] = [:]
    /// The pipeline serializes calls itself; this queue keeps its blocking Core ML work off the Swift concurrency pool.
    private let queue = DispatchQueue(label: "com.example.phiremote.kokoro", qos: .userInitiated)

    /// Loads every Core ML stage with `plan`'s compute units (the first `.ane` load after installing or updating iOS compiles
    /// them for the Neural Engine). `onStage(name, done, ms)` reports each stage as it starts and ends.
    static func load(root: URL, lexicon: [String: String], plan: KokoroAneV3ComputePlan = .ane,
                     onStage: (@Sendable (String, Bool, Double) -> Void)? = nil) async throws -> KokoroEngine {
        let vocab = try KokoroAneVocab.load(from: root.appendingPathComponent("vocab.json"))
        let pipeline = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<KokoroAneV3Pipeline, Error>) in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    cont.resume(returning: try KokoroAneV3Pipeline(
                        baseDirectory: root.appendingPathComponent("base"),
                        fastDirectory: root.appendingPathComponent("fast"),
                        decoderDirectory: root.appendingPathComponent("decoder"),
                        plan: plan, onStage: onStage))
                } catch { cont.resume(throwing: error) }
            }
        }
        onStage?("G2P", false, 0)
        var t = DispatchTime.now().uptimeNanoseconds
        let g2p = G2PModel.shared(directory: root)
        do { try await g2p.ensureModelsAvailable() } catch {
            throw KokoroAneV3StageError(stage: "G2P", plan: .cpu, underlying: error)
        }
        onStage?("G2P", true, Double(DispatchTime.now().uptimeNanoseconds - t) / 1e6)
        // Stress/length marks (ˈ ˌ ː) are Unicode modifier letters, so `isLetter` keeps them out of the punctuation set.
        let punctuation = Set(vocab.map.keys.filter { !$0.isLetter && !$0.isNumber && !$0.isWhitespace })
        onStage?("Lexicon", false, 0)
        t = DispatchTime.now().uptimeNanoseconds
        let cache = LexiconAssetCache()
        try await cache.ensureLoaded(kokoroDirectory: root.appendingPathComponent("kokoro"),
                                     allowedTokens: Set(vocab.map.keys.map(String.init)))
        let maps = await cache.lexicons()
        onStage?("Lexicon", true, Double(DispatchTime.now().uptimeNanoseconds - t) / 1e6)
        return KokoroEngine(root: root, pipeline: pipeline, vocab: vocab, g2p: g2p, maps: maps, punctuation: punctuation, lexicon: lexicon)
    }

    init(root: URL, pipeline: KokoroAneV3Pipeline, vocab: KokoroAneVocab, g2p: G2PModel,
                 maps: (word: [String: [String]], caseSensitive: [String: [String]]), punctuation: Set<Character>, lexicon: [String: String]) {
        self.root = root
        self.pipeline = pipeline
        self.vocab = vocab
        self.g2p = g2p
        self.wordMaps = maps
        self.punctuation = punctuation
        self.lexicon = lexicon
        self.phonemizer = KokoroEngine.makePhonemizer(maps: maps, lexicon: lexicon, punctuation: punctuation)
    }

    private static func makePhonemizer(maps: (word: [String: [String]], caseSensitive: [String: [String]]),
                                       lexicon: [String: String], punctuation: Set<Character>) -> KokoroAneEnglishPhonemizer {
        KokoroAneEnglishPhonemizer(wordToPhonemes: maps.word, caseSensitiveWordToPhonemes: maps.caseSensitive,
                                   customLexicon: lexicon, allowedPunctuation: punctuation)
    }

    /// Word -> Misaki IPA overrides, checked before the lexicon ("phi" -> "fˈI").
    func setLexicon(_ entries: [String: String]) {
        lexicon = entries
        phonemizer = KokoroEngine.makePhonemizer(maps: wordMaps, lexicon: entries, punctuation: punctuation)
    }

    func voicePack(_ name: String) throws -> KokoroAneVoicePack {
        if let v = voices[name] { return v }
        let flat = root.appendingPathComponent("\(name).bin")
        let converted = root.appendingPathComponent("voices/\(name).bin")
        let url = FileManager.default.fileExists(atPath: flat.path) ? flat : converted
        let pack = try KokoroAneVoicePack.load(from: url)
        voices[name] = pack
        return pack
    }

    /// Text -> the phoneme string the model reads (normalization + lexicon + G2P), as FluidAudio's English path does.
    func phonemes(_ text: String) async throws -> String {
        let normalized = EnglishTextNormalizer.normalizeForFrontend(text)
        let raw = try await phonemizer.phonemize(normalized) { [g2p] word in try await g2p.phonemize(word: word) }
        // misaki's flap step for Kokoro v1.0: ɾ -> T (KokoroAneManager.misakiOutputForm).
        return raw.replacingOccurrences(of: "ɾ", with: "T")
    }

    func synthesize(_ text: String, voice: String, speed: Float) async throws -> Synthesis {
        let phonemes = try await phonemes(text)
        let pack = try voicePack(voice)
        let pieces = PhonemeChunker.chunk(phonemes, maxLength: KokoroAneConstants.maxPhonemeLength, countsUnicodeScalars: true)
        var samples: [Float] = []
        var frames = 0
        var fast = true
        var stages: [String: Double] = [:]
        for piece in pieces {
            try Task.checkCancellation()
            let ids = try vocab.encode(piece)
            let (styleS, timbre) = pack.slice(for: KokoroAneVocab.phonemeLength(piece))
            let result = try await run(ids: ids, style: timbre + styleS, speed: speed)
            samples += result.samples
            frames += result.acousticFrames
            fast = fast && result.usedFastVocoder
            for (k, v) in result.stageMilliseconds { stages[k, default: 0] += v }
        }
        return Synthesis(samples: samples, frames: frames, fast: fast, phonemes: phonemes, stageMs: stages)
    }

    private func run(ids: [Int32], style: [Float], speed: Float) async throws -> KokoroAneV3Pipeline.Result {
        try await withCheckedThrowingContinuation { cont in
            queue.async { [pipeline] in
                do { cont.resume(returning: try pipeline.synthesize(inputIds: ids, style: style, speed: speed)) }
                catch { cont.resume(throwing: error) }
            }
        }
    }
}

/// The pipeline serializes its calls with its own lock, so handing it to the synthesis queue is safe.
extension KokoroAneV3Pipeline: @unchecked Sendable {}
