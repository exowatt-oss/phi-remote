// Shims.swift (phi remote, not from FluidAudio): minimal stand-ins for the parts of FluidAudio's infrastructure the
// vendored Kokoro files reference: its logger, the G2P file names, the default cache root and the one asset helper the
// v3 pipeline calls. Downloads are done by KokoroModelStore, not by FluidAudio's downloaders.
import Foundation
import os

struct AppLogger {
    private let log: Logger

    init(subsystem: String = "com.example.phiremote", category: String) {
        log = Logger(subsystem: "com.example.phiremote", category: "tts.\(category)")
    }

    func debug(_ message: String) { log.debug("\(message, privacy: .public)") }
    func info(_ message: String) { log.info("\(message, privacy: .public)") }
    func notice(_ message: String) { log.notice("\(message, privacy: .public)") }
    func warning(_ message: String) { log.warning("\(message, privacy: .public)") }
    func error(_ message: String) { log.error("\(message, privacy: .public)") }
}

enum ModelNames {
    enum G2P {
        static let encoderFile = "G2PEncoder.mlmodelc"
        static let decoderFile = "G2PDecoder.mlmodelc"
        static let vocabularyFile = "g2p_vocab.json"
    }
}

/// Only used when a G2P model is created without a directory, which phi remote never does.
enum TtsCacheDirectory {
    static func ensure() throws -> URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("KokoroTTS")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}

/// From FluidAudio's KokoroAneV3Assets (Apache-2.0): a compiled bundle is load-ready when it holds `coremldata.bin`.
enum KokoroAneV3Assets {
    static func isCompiledBundle(at url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue
        else { return false }
        return FileManager.default.fileExists(atPath: url.appendingPathComponent("coremldata.bin").path)
    }
}
