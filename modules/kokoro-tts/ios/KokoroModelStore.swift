// KokoroModelStore.swift: first-use delivery of the Kokoro-82M Core ML files (~227 MB) from Hugging Face, the same way
// modules/phonon-stt's ModelStore delivers Phonon-2:
//   * every file pinned to one repository revision (resolve URLs) and checked against its SHA-256
//   * resumable: each file streams into "<name>.part" with HTTP Range requests, so a dropped connection or a killed app
//     continues where it stopped
//   * Wi-Fi only unless the caller allows cellular (the OS enforces it per request: a Wi-Fi drop pauses, never switches)
//   * stored in Application Support/KokoroModels/<revision>/, excluded from iCloud/iTunes backup
//   * a free-space check before the download (the files plus room for the compile)
//   * "ready" = the marker and every final file in place; a ready model with files missing is repaired by fetching only those
//   * after the download: the extra voices' JSON rows become the runtime's flat .bin packs, every .mlpackage is compiled
//     once with MLModel.compileModel into the sibling .mlmodelc the v3 pipeline loads, and the package is deleted (one
//     copy of the weights on the phone)
//
// Sources: FluidInference/kokoro-82m-coreml (Apache-2.0) at two immutable revisions: `base` = the seven-stage export
// FluidAudio's ANE-v3 runtime builds on, `v3` = the ANE-v3 fast stages, the English G2P model and the Misaki lexicon.
import CoreML
import CryptoKit
import Foundation

@available(iOS 18.0, macOS 15.0, *)
final class KokoroModelStore: NSObject, URLSessionDataDelegate {
    static let repo = "FluidInference/kokoro-82m-coreml"
    static let baseRevision = "006395f65025af251858b1ab0a7178a6a1e73f9f"
    static let v3Revision = "6c0750dd02ef9d981fb82f147d784a3f171755ee"
    enum Rev { case base, v3 }
    struct Item {
        let rev: Rev; let remote: String; let local: String; let size: Int64; let sha256: String
        init(_ rev: Rev, _ remote: String, _ local: String, _ size: Int64, _ sha256: String) {
            self.rev = rev; self.remote = remote; self.local = local; self.size = size; self.sha256 = sha256
        }
    }
    /// Sizes and SHA-256 from the Hugging Face tree API (LFS oids) and the files themselves, at the pinned revisions.
    static let items: [Item] = [
        Item(.base, "ANE/KokoroAlbert.mlpackage/Data/com.apple.CoreML/model.mlmodel", "base/KokoroAlbert.mlpackage/Data/com.apple.CoreML/model.mlmodel", 92156, "1efeed89cf916ee5fd38a7b4aef8d79a6444eef6b5521514c5ab34e7164f36a2"),
        Item(.base, "ANE/KokoroAlbert.mlpackage/Data/com.apple.CoreML/weights/weight.bin", "base/KokoroAlbert.mlpackage/Data/com.apple.CoreML/weights/weight.bin", 5718848, "36089a39359b800d3e2c60e5e8ac9217d8f2d1010a8b9273192290e621f1fabc"),
        Item(.base, "ANE/KokoroAlbert.mlpackage/Manifest.json", "base/KokoroAlbert.mlpackage/Manifest.json", 617, "10df12c725ef649894bb0b6e2094348fc5571c846322889cffc59f2e255241e7"),
        Item(.base, "ANE/KokoroPostAlbert.mlpackage/Data/com.apple.CoreML/model.mlmodel", "base/KokoroPostAlbert.mlpackage/Data/com.apple.CoreML/model.mlmodel", 49183, "5b1ec258a17ca6419da5c90c66e147a7c3699ea3ed620c4b0db715f6b3f5aa26"),
        Item(.base, "ANE/KokoroPostAlbert.mlpackage/Data/com.apple.CoreML/weights/weight.bin", "base/KokoroPostAlbert.mlpackage/Data/com.apple.CoreML/weights/weight.bin", 13806464, "e4f300a23cc2e05d38680d9fc94681cc722d445076d1d248f83255122ba091c8"),
        Item(.base, "ANE/KokoroPostAlbert.mlpackage/Manifest.json", "base/KokoroPostAlbert.mlpackage/Manifest.json", 617, "2d0fd3c94d21d690dbad0e96a395cd02dc8dbb4e04f4f814963173973d48ef25"),
        Item(.base, "ANE/KokoroAlignment.mlpackage/Data/com.apple.CoreML/model.mlmodel", "base/KokoroAlignment.mlpackage/Data/com.apple.CoreML/model.mlmodel", 6971, "2d87764d55eb2bdf4ea9ced45b63ff51b4a0e139d5440b2d52c03076f06d8512"),
        Item(.base, "ANE/KokoroAlignment.mlpackage/Data/com.apple.CoreML/weights/weight.bin", "base/KokoroAlignment.mlpackage/Data/com.apple.CoreML/weights/weight.bin", 4128, "2e7d69128b59d615fc3d3cf85637a687235fc086b1eb136359adb11a61615f6b"),
        Item(.base, "ANE/KokoroAlignment.mlpackage/Manifest.json", "base/KokoroAlignment.mlpackage/Manifest.json", 617, "1c98efe4432ea2d8a53ccc0af34dbde1c99e1c959bfb9c648b1f14550e3348e6"),
        Item(.base, "ANE/KokoroProsody_v2.mlmodelc/analytics/coremldata.bin", "base/KokoroProsody_v2.mlmodelc/analytics/coremldata.bin", 243, "804d7d2e9a8fed345cedb57da61bd27fdd95db22a070cfa7d42ccd4f8e80a443"),
        Item(.base, "ANE/KokoroProsody_v2.mlmodelc/coremldata.bin", "base/KokoroProsody_v2.mlmodelc/coremldata.bin", 421, "db8776a4896f690fd254cdb68a4551c168411c9b3fb98219630215bc3c357986"),
        Item(.base, "ANE/KokoroProsody_v2.mlmodelc/model.mil", "base/KokoroProsody_v2.mlmodelc/model.mil", 73353, "e6acad9f44d70b1dba0aea6a5d25ee4edf68fe8f2933399ee81f70ace61cbc8b"),
        Item(.base, "ANE/KokoroProsody_v2.mlmodelc/weights/weight.bin", "base/KokoroProsody_v2.mlmodelc/weights/weight.bin", 8513664, "70eea4cd2523992fa1fea840e31ab6f4fdd69c1598e220985a2ae6ea5da1e944"),
        Item(.base, "ANE/KokoroNoise_v2.mlpackage/Data/com.apple.CoreML/model.mlmodel", "base/KokoroNoise_v2.mlpackage/Data/com.apple.CoreML/model.mlmodel", 76250, "894168c950938e0b776f010b4278b1aae65aa1ce3dd8bdfa4c4170ca80362d0d"),
        Item(.base, "ANE/KokoroNoise_v2.mlpackage/Data/com.apple.CoreML/weights/weight.bin", "base/KokoroNoise_v2.mlpackage/Data/com.apple.CoreML/weights/weight.bin", 4580160, "1102fc2d31dfcfe3de3978a4c78b65202ff8b0a4d55a9304213bd4e8bda66bc2"),
        Item(.base, "ANE/KokoroNoise_v2.mlpackage/Manifest.json", "base/KokoroNoise_v2.mlpackage/Manifest.json", 617, "143586c48da49b399761e0b40371dba6191d6060a9a238cbbcec7ed81cc35d73"),
        Item(.base, "ANE/KokoroVocoder.mlpackage/Data/com.apple.CoreML/model.mlmodel", "base/KokoroVocoder.mlpackage/Data/com.apple.CoreML/model.mlmodel", 255741, "18481f9531abd0d01cf6fe6b8837b98263e8a63d87db56324d49ed57cc5c75fa"),
        Item(.base, "ANE/KokoroVocoder.mlpackage/Data/com.apple.CoreML/weights/weight.bin", "base/KokoroVocoder.mlpackage/Data/com.apple.CoreML/weights/weight.bin", 48889920, "6d1f96eb50218ab687b12d6d862d2ae854c12b7165c3cd9b6b5cef261ef02ff1"),
        Item(.base, "ANE/KokoroVocoder.mlpackage/Manifest.json", "base/KokoroVocoder.mlpackage/Manifest.json", 617, "83fc9c3c356e0c4022f9547519a2e0919d0e0e40727a0829d60bb69212e28855"),
        Item(.base, "ANE/KokoroTail_v2.mlmodelc/analytics/coremldata.bin", "base/KokoroTail_v2.mlmodelc/analytics/coremldata.bin", 243, "a06e4b91c2b8a8be3ff701558a5f1f6484921f948202663fe6df78f248d42222"),
        Item(.base, "ANE/KokoroTail_v2.mlmodelc/coremldata.bin", "base/KokoroTail_v2.mlmodelc/coremldata.bin", 392, "527271f6df56cc308a5f89374c92108aef7b837ab15f0ba4900d555588dbd905"),
        Item(.base, "ANE/KokoroTail_v2.mlmodelc/metadata.json", "base/KokoroTail_v2.mlmodelc/metadata.json", 1872, "7708ecc145eecf8e3ef5ef8979ea7a4f77d04c8da787454c6d9190e5300fc50b"),
        Item(.base, "ANE/KokoroTail_v2.mlmodelc/model.mil", "base/KokoroTail_v2.mlmodelc/model.mil", 7014, "b0b8fd573bac76ba7eb85730eeb25538fc7f1c666ecbf939fd4b3a4ad4495ad7"),
        Item(.base, "ANE/KokoroTail_v2.mlmodelc/weights/weight.bin", "base/KokoroTail_v2.mlmodelc/weights/weight.bin", 81088, "8ede31ec20df7d86a124287ac12d13507651e2a693e9d4f35f0e7f92cba422c7"),
        Item(.base, "ANE/af_heart.bin", "af_heart.bin", 522240, "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b"),
        Item(.base, "ANE/vocab.json", "vocab.json", 1416, "8d65b0188b77eafc60751dac42bbac7ab5f5685074af44db91d1877b42dc1d7c"),
        Item(.v3, "ANE-v3/fast/KokoroAlbert_32.mlpackage/Data/com.apple.CoreML/model.mlmodel", "fast/KokoroAlbert_32.mlpackage/Data/com.apple.CoreML/model.mlmodel", 90614, "445dc9bcfa196da380a3b47bf602307cbec01a529b407df4ba31c34ba9980b86"),
        Item(.v3, "ANE-v3/fast/KokoroAlbert_32.mlpackage/Data/com.apple.CoreML/weights/weight.bin", "fast/KokoroAlbert_32.mlpackage/Data/com.apple.CoreML/weights/weight.bin", 5718848, "36089a39359b800d3e2c60e5e8ac9217d8f2d1010a8b9273192290e621f1fabc"),
        Item(.v3, "ANE-v3/fast/KokoroAlbert_32.mlpackage/Manifest.json", "fast/KokoroAlbert_32.mlpackage/Manifest.json", 617, "7275b5a061ed9a95dfa8b182a553e0e97c64d619000899f14a8d922d75d0b9e8"),
        Item(.v3, "ANE-v3/fast/KokoroAlbert_64.mlpackage/Data/com.apple.CoreML/model.mlmodel", "fast/KokoroAlbert_64.mlpackage/Data/com.apple.CoreML/model.mlmodel", 90646, "8dacdea951068efa8dd1370b4d8b7156fcdcef6c34f0f8d15e4d35070db8e645"),
        Item(.v3, "ANE-v3/fast/KokoroAlbert_64.mlpackage/Data/com.apple.CoreML/weights/weight.bin", "fast/KokoroAlbert_64.mlpackage/Data/com.apple.CoreML/weights/weight.bin", 5718848, "36089a39359b800d3e2c60e5e8ac9217d8f2d1010a8b9273192290e621f1fabc"),
        Item(.v3, "ANE-v3/fast/KokoroAlbert_64.mlpackage/Manifest.json", "fast/KokoroAlbert_64.mlpackage/Manifest.json", 617, "3a99d60a9b318f65caa4918799e69fe7a1548f15dbf38d0cdc3c95afa6f66561"),
        Item(.v3, "ANE-v3/fast/KokoroSourceGenerator.mlpackage/Data/com.apple.CoreML/model.mlmodel", "fast/KokoroSourceGenerator.mlpackage/Data/com.apple.CoreML/model.mlmodel", 357002, "e2fadc3aba5d8ff69b2473fcd69e9a4d988d4d6c7ca8c383e5902d2b68338cab"),
        Item(.v3, "ANE-v3/fast/KokoroSourceGenerator.mlpackage/Data/com.apple.CoreML/weights/weight.bin", "fast/KokoroSourceGenerator.mlpackage/Data/com.apple.CoreML/weights/weight.bin", 39353848, "e4ada8b28c56a4acda6a88e7c6d076aa65a39051841597bc0c4c07a60afe5ac2"),
        Item(.v3, "ANE-v3/fast/KokoroSourceGenerator.mlpackage/Manifest.json", "fast/KokoroSourceGenerator.mlpackage/Manifest.json", 617, "c33fd43b96f425410f39d1b5b2fb805ddba985b543f04b6fa6b516bc96caeddb"),
        Item(.v3, "ANE-v3/decoder/KokoroDecoderPre_120.mlpackage/Data/com.apple.CoreML/model.mlmodel", "decoder/KokoroDecoderPre_120.mlpackage/Data/com.apple.CoreML/model.mlmodel", 87461, "cd1fc5ed538f7fb6f57e38dc30c71cbe498344fde764720ec41d8d9b868887ba"),
        Item(.v3, "ANE-v3/decoder/KokoroDecoderPre_120.mlpackage/Data/com.apple.CoreML/weights/weight.bin", "decoder/KokoroDecoderPre_120.mlpackage/Data/com.apple.CoreML/weights/weight.bin", 33642176, "7f4ba8ddae5d4b6e73bdd19f2d79489963ab41fc1a57d1606001f3cfe5fe82dc"),
        Item(.v3, "ANE-v3/decoder/KokoroDecoderPre_120.mlpackage/Manifest.json", "decoder/KokoroDecoderPre_120.mlpackage/Manifest.json", 617, "72d8e9e63859d9df75d74692dd280ffb9f5a106d12f5d25980ab85ecb7a8aefa"),
        Item(.v3, "ANE-v3/decoder/KokoroDecoderPre_200.mlpackage/Data/com.apple.CoreML/model.mlmodel", "decoder/KokoroDecoderPre_200.mlpackage/Data/com.apple.CoreML/model.mlmodel", 87594, "1f85ffa9dce80aee4a24392b41aa41d765e39dd55748b1e0b69df6c1b9d0fa60"),
        Item(.v3, "ANE-v3/decoder/KokoroDecoderPre_200.mlpackage/Data/com.apple.CoreML/weights/weight.bin", "decoder/KokoroDecoderPre_200.mlpackage/Data/com.apple.CoreML/weights/weight.bin", 33642176, "0b758dd755a4fab0c1f4a0a16f302d59e8bb38b2200a8bd29f21acfa61e6547c"),
        Item(.v3, "ANE-v3/decoder/KokoroDecoderPre_200.mlpackage/Manifest.json", "decoder/KokoroDecoderPre_200.mlpackage/Manifest.json", 617, "97d52d353b1229c955316a14e056688b1d742b27fe5736d3ff4e1fbe2189539a"),
        Item(.v3, "ANE-v3/fast/native-source.json", "fast/native-source.json", 8340, "8c673a8a177056db2a91f214b40ab9033f7a3221bd1be5ef4282c6403cff0de3"),
        Item(.v3, "G2PDecoder.mlmodelc/analytics/coremldata.bin", "kokoro/G2PDecoder.mlmodelc/analytics/coremldata.bin", 243, "dbf1767747fdc188222d467a45b04608b396c76c71db3abb18a5fb3680ef9827"),
        Item(.v3, "G2PDecoder.mlmodelc/coremldata.bin", "kokoro/G2PDecoder.mlmodelc/coremldata.bin", 545, "607e960f19b4d9a30317a5a11869fcce84b300a909fcab2cc756c0d98e2dacd9"),
        Item(.v3, "G2PDecoder.mlmodelc/metadata.json", "kokoro/G2PDecoder.mlmodelc/metadata.json", 3064, "e54e98484fd60d26f22fd3c4e7fe87b0d92a5d2de1f958cc3c4bb36d4ae06a44"),
        Item(.v3, "G2PDecoder.mlmodelc/model.mil", "kokoro/G2PDecoder.mlmodelc/model.mil", 19737, "fe647c598e0d9454d360b8ee49a59ae57ca147fc5330863ba84ccb90dce482ad"),
        Item(.v3, "G2PDecoder.mlmodelc/weights/weight.bin", "kokoro/G2PDecoder.mlmodelc/weights/weight.bin", 828030, "cbaeb4e743359f607ab161af0c6d8a817462fdaec622ee788ef8ef952c5f8214"),
        Item(.v3, "G2PEncoder.mlmodelc/analytics/coremldata.bin", "kokoro/G2PEncoder.mlmodelc/analytics/coremldata.bin", 243, "cf7fbd7e7a65529b2d2bf3941e458a0ab6dff7a298bf48e205a1727c81c26a99"),
        Item(.v3, "G2PEncoder.mlmodelc/coremldata.bin", "kokoro/G2PEncoder.mlmodelc/coremldata.bin", 398, "0f14d46ca9fd06c68b4717294575b2b99449e67d40b7a2c56f926bf05cd90b11"),
        Item(.v3, "G2PEncoder.mlmodelc/metadata.json", "kokoro/G2PEncoder.mlmodelc/metadata.json", 2034, "c8e0cfd7f494ac1b3662ff8f1914b2b45f79ffb2791724cdc0576981996732e1"),
        Item(.v3, "G2PEncoder.mlmodelc/model.mil", "kokoro/G2PEncoder.mlmodelc/model.mil", 20392, "8c617e569f37286b056dad800d862dc145be9a95fa9ed43857bb646ba199d7da"),
        Item(.v3, "G2PEncoder.mlmodelc/weights/weight.bin", "kokoro/G2PEncoder.mlmodelc/weights/weight.bin", 694592, "6926bcd2827d21fec82839487b987e06f85fd8a6a5bb896bc4f6062461d014ec"),
        Item(.v3, "g2p_vocab.json", "kokoro/g2p_vocab.json", 1665, "295ed64b86c2820cd665b0602ae50c6947c0e82ac643082873e0be87dca282ce"),
        Item(.v3, "us_lexicon_cache.json", "kokoro/us_lexicon_cache.json", 10444631, "6b36ba313202227d6914ad32cd684a0304bd2757e9ec4158ea7bc36ec40e224e"),
        Item(.base, "voices/af_bella.json", "voices/af_bella.json", 2678538, "e7bdbe207b927d1e59556dcda69b976cbbdc87be5e4affeea5bf030fca80e55c"),
        Item(.base, "voices/af_sarah.json", "voices/af_sarah.json", 2672574, "3c5270deda46faf0130837100a51ccbe39f5c268886f59e31aca52687b876ecf"),
        Item(.base, "voices/am_michael.json", "voices/am_michael.json", 2667552, "ec6e03f1fc30c11020ade45f587a64e1b8c51c08e8ab6f59bdf089f410c2b924"),
        Item(.base, "voices/am_fenrir.json", "voices/am_fenrir.json", 2678091, "7c983af1d3317de8a821ea46ab3cb8f1839624f91adb66bb5f24043a777078ba"),
        Item(.base, "voices/am_puck.json", "voices/am_puck.json", 2671969, "3f603430c6050de2b00626aa9509fdfcd5a119b33dee88a05d7174897bf12694"),
    ]
    static var totalBytes: Int64 { items.reduce(0) { $0 + $1.size } }

    enum Failure: LocalizedError {
        case http(Int, String), checksum(String), cancelled, noSpace(Int64)
        var errorDescription: String? {
            switch self {
            case .http(let c, let p): return "Download of \(p) failed (HTTP \(c))."
            case .checksum(let p): return "\(p) did not match its checksum; it will be downloaded again."
            case .cancelled: return "Download cancelled."
            case .noSpace(let bytes): return "Not enough space: free up \(max(1, bytes / 1_000_000)) MB on this iPhone."
            }
        }
    }

    let root: URL
    var progress: ((Double, String) -> Void)?
    private var session: URLSession!
    private var current: (handle: FileHandle, done: Int64, base: Int64, cont: CheckedContinuation<Void, Error>, status: Int)?
    private let lock = NSLock()
    private var cancelled = false
    private var onBytes: ((Int64) -> Void)?

    /// Application Support/KokoroModels: every revision's folder lives under it ("Remove" deletes it all).
    static var modelsDir: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("KokoroModels")
    }
    static var defaultRoot: URL { modelsDir.appendingPathComponent("kokoro-82m-v3-\(v3Revision.prefix(12))") }

    init(root: URL? = nil, allowCellular: Bool = false) {
        self.root = root ?? KokoroModelStore.defaultRoot
        super.init()
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 60
        cfg.waitsForConnectivity = true
        cfg.allowsExpensiveNetworkAccess = allowCellular
        cfg.allowsConstrainedNetworkAccess = allowCellular
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }

    static func removeAll() throws {
        let fm = FileManager.default
        if fm.fileExists(atPath: modelsDir.path) { try fm.removeItem(at: modelsDir) }
    }

    /// Bytes on disk under the model folder (finished files, .part files, compiled bundles).
    func bytesOnDisk() -> Int64 { KokoroModelStore.bytesOnDisk(at: root) }
    static func bytesOnDisk(at root: URL = defaultRoot) -> Int64 {
        var bytes: Int64 = 0
        if let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey]) {
            for case let u as URL in e { bytes += Int64((try? u.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
        }
        return bytes
    }

    static func url(_ item: Item) -> URL {
        let rev = item.rev == .base ? baseRevision : v3Revision
        return URL(string: "https://huggingface.co/\(repo)/resolve/\(rev)/\(item.remote)")!
    }
    var readyMarker: URL { root.appendingPathComponent(".ready") }
    /// Downloaded, verified and compiled: the marker and every file the runtime loads.
    var isReady: Bool { KokoroModelStore.isReady(at: root) }
    static func isReady(at root: URL = defaultRoot) -> Bool {
        hasReadyMarker(at: root) && missing(at: root).isEmpty
    }
    static func hasReadyMarker(at root: URL = defaultRoot) -> Bool {
        FileManager.default.fileExists(atPath: root.appendingPathComponent(".ready").path)
    }

    /// Where an item ends up once the download is done: a package file -> its compiled bundle's coremldata.bin, a voice's JSON
    /// rows -> its .bin pack, anything else stays as downloaded.
    static func finalPath(_ item: Item) -> String {
        if let r = item.local.range(of: ".mlpackage/") { return String(item.local[..<r.lowerBound]) + ".mlmodelc/coremldata.bin" }
        if item.local.hasPrefix("voices/"), item.local.hasSuffix(".json") { return String(item.local.dropLast(5)) + ".bin" }
        return item.local
    }

    /// The final files that are not on disk (an earlier build deleted a compiled bundle after a failed load; storage cleanup).
    static func missing(at root: URL = defaultRoot) -> [String] {
        var seen = Set<String>()
        return items.map(finalPath).filter { seen.insert($0).inserted }
            .filter { !FileManager.default.fileExists(atPath: root.appendingPathComponent($0).path) }
    }

    /// Settings › Voice › Diagnostics: every model file or compiled bundle with its size (-1 = missing), the folder's file
    /// protection and backup flag, free space.
    static func diagnostics(at root: URL = defaultRoot) -> [String: Any] {
        let fm = FileManager.default
        var seen = Set<String>()
        let artifacts = items.map { item -> String in
            let p = finalPath(item)
            if let r = p.range(of: ".mlmodelc/") { return String(p[..<r.lowerBound]) + ".mlmodelc" }
            return p
        }.filter { seen.insert($0).inserted }
        let files: [[String: Any]] = artifacts.map { rel in
            let url = root.appendingPathComponent(rel)
            guard fm.fileExists(atPath: url.path) else { return ["path": rel, "bytes": -1] }
            return ["path": rel, "bytes": Int(rel.hasSuffix(".mlmodelc") ? bytesOnDisk(at: url) : Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0))]
        }
        let probe = fm.fileExists(atPath: root.path) ? root : modelsDir.deletingLastPathComponent()
        let free = (try? probe.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage) ?? -1
        var protection = "n/a"
        #if os(iOS)
        let weight = root.appendingPathComponent("base/KokoroVocoder.mlmodelc/weights/weight.bin")
        let p1 = (try? fm.attributesOfItem(atPath: root.path)[.protectionKey] as? FileProtectionType)?.rawValue ?? "none"
        let p2 = (try? fm.attributesOfItem(atPath: weight.path)[.protectionKey] as? FileProtectionType)?.rawValue ?? "none"
        protection = p1 == p2 ? p1 : "\(p1) (folder), \(p2) (weights)"
        #endif
        let excluded = (try? root.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup) ?? false
        let miss = missing(at: root)
        return ["dir": root.path, "readyMarker": hasReadyMarker(at: root), "intact": miss.isEmpty, "missing": miss, "files": files,
                "bytesOnDisk": Int(bytesOnDisk(at: root)), "freeBytes": Int(free), "protection": protection, "excludedFromBackup": excluded]
    }

    func cancel() { lock.lock(); cancelled = true; lock.unlock(); session.invalidateAndCancel() }

    /// Where a source package's compiled bundle goes ("base/KokoroAlbert.mlpackage/..." -> "base/KokoroAlbert.mlmodelc").
    private func compiledBundle(forPackageFile path: String) -> URL? {
        guard let r = path.range(of: ".mlpackage/") else { return nil }
        return root.appendingPathComponent(String(path[..<r.lowerBound]) + ".mlmodelc")
    }

    /// Voice JSON rows ("1"..."510" -> 256 floats) are converted to "<name>.bin" and the JSON deleted.
    private func voiceBin(forJSON path: String) -> URL? {
        guard path.hasPrefix("voices/"), path.hasSuffix(".json") else { return nil }
        return root.appendingPathComponent(String(path.dropLast(5)) + ".bin")
    }

    /// The item is already in its final form (verified file, compiled bundle, or converted voice).
    private func isDone(_ item: Item) -> Bool {
        let fm = FileManager.default
        if let bundle = compiledBundle(forPackageFile: item.local),
           fm.fileExists(atPath: bundle.appendingPathComponent("coremldata.bin").path) { return true }
        if let bin = voiceBin(forJSON: item.local), fm.fileExists(atPath: bin.path) { return true }
        return fm.fileExists(atPath: root.appendingPathComponent(item.local).path)   // renamed only after its checksum matched
    }

    /// Download (or resume), verify, convert, compile. Returns the model folder.
    func ensure() async throws -> URL {
        defer { session.finishTasksAndInvalidate() }   // the session retains this delegate until invalidated
        // A marker with files missing (see `missing`) is repaired here: isDone skips everything still in place.
        if isReady { return root }
        let fm = FileManager.default
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        var rv = URLResourceValues(); rv.isExcludedFromBackup = true
        var r = root; try r.setResourceValues(rv)
        let total = Double(KokoroModelStore.totalBytes)
        let pending = KokoroModelStore.items.filter { !isDone($0) }
        let have = bytesOnDisk()
        // The files still to fetch, plus the largest package again (compileModel writes a copy before the package goes).
        let need = pending.reduce(Int64(0)) { $0 + $1.size } - min(have, pending.reduce(Int64(0)) { $0 + $1.size }) + 60_000_000
        if let free = try? root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage,
           free > 0, free < need {
            throw Failure.noSpace(need - free)
        }
        var finished: Int64 = KokoroModelStore.items.filter { isDone($0) }.reduce(0) { $0 + $1.size }
        for item in pending {
            let dst = root.appendingPathComponent(item.local)
            try fm.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
            let part = dst.appendingPathExtension("part")
            var attempt = 0
            while true {
                do {
                    try await fetch(item, to: part) { got in self.progress?((Double(finished) + Double(got)) / total, item.local) }
                    break
                } catch Failure.cancelled { throw Failure.cancelled }
                catch {
                    attempt += 1
                    if attempt >= 5 { throw error }
                    try await Task.sleep(nanoseconds: UInt64(attempt) * 2_000_000_000)
                }
            }
            if try KokoroModelStore.sha256(of: part) != item.sha256 { try? fm.removeItem(at: part); throw Failure.checksum(item.local) }
            try? fm.removeItem(at: dst)
            try fm.moveItem(at: part, to: dst)
            finished += item.size
        }
        progress?(1, "compiling")
        try convertVoices()
        try await compilePackages()
        fm.createFile(atPath: readyMarker.path, contents: Data())
        return root
    }

    private func convertVoices() throws {
        let fm = FileManager.default
        for item in KokoroModelStore.items {
            guard let bin = voiceBin(forJSON: item.local), !fm.fileExists(atPath: bin.path) else { continue }
            let json = root.appendingPathComponent(item.local)
            let pack = try KokoroAneVoicePack.load(fromJSON: Data(contentsOf: json))
            try pack.binaryData.write(to: bin, options: .atomic)
            try? fm.removeItem(at: json)
        }
    }

    /// Every "<dir>/<name>.mlpackage" -> "<dir>/<name>.mlmodelc", then the package is deleted.
    private func compilePackages() async throws {
        let fm = FileManager.default
        for dir in ["base", "fast", "decoder"] {
            let folder = root.appendingPathComponent(dir)
            let names = (try? fm.contentsOfDirectory(atPath: folder.path)) ?? []
            for name in names.sorted() where name.hasSuffix(".mlpackage") {
                let pkg = folder.appendingPathComponent(name)
                let compiled = folder.appendingPathComponent(String(name.dropLast(".mlpackage".count)) + ".mlmodelc")
                if !fm.fileExists(atPath: compiled.appendingPathComponent("coremldata.bin").path) {
                    let tmp = try await MLModel.compileModel(at: pkg)
                    try? fm.removeItem(at: compiled)
                    try fm.moveItem(at: tmp, to: compiled)
                }
                try? fm.removeItem(at: pkg)
            }
        }
    }

    /// GET with `Range: bytes=<part size>-`, appending to `part`.
    private func fetch(_ item: Item, to part: URL, onBytes: @escaping (Int64) -> Void) async throws {
        let fm = FileManager.default
        if !fm.fileExists(atPath: part.path) { fm.createFile(atPath: part.path, contents: nil) }
        let have = (try? fm.attributesOfItem(atPath: part.path)[.size] as? NSNumber)?.int64Value ?? 0
        if have >= item.size && have > 0 { return }   // complete .part from an earlier run: verify it
        var req = URLRequest(url: KokoroModelStore.url(item))
        if have > 0 { req.setValue("bytes=\(have)-", forHTTPHeaderField: "Range") }
        let handle = try FileHandle(forWritingTo: part)
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            lock.lock()
            if cancelled { lock.unlock(); try? handle.close(); cont.resume(throwing: Failure.cancelled); return }
            current = (handle, 0, have, cont, 0)
            self.onBytes = onBytes
            lock.unlock()
            session.dataTask(with: req).resume()
        }
    }

    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        lock.lock()
        if var c = current {
            c.status = code
            if code == 200 { try? c.handle.truncate(atOffset: 0); try? c.handle.seek(toOffset: 0); c.base = 0 }   // no range support: restart
            else if code == 206 { _ = try? c.handle.seekToEnd() }
            current = c
        }
        lock.unlock()
        completionHandler(code == 200 || code == 206 ? .allow : .cancel)
    }
    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock(); guard var c = current else { lock.unlock(); return }
        do { try c.handle.write(contentsOf: data) } catch {
            // Disk full mid-download: stop this request; the error surfaces from didCompleteWithError.
            lock.unlock(); dataTask.cancel(); writeError = error; return
        }
        c.done += Int64(data.count); current = c
        let got = c.base + c.done; let report = onBytes; lock.unlock()
        report?(got)
    }
    private var writeError: Error?
    func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); let c = current; current = nil; let wErr = writeError; writeError = nil; lock.unlock()
        guard let c else { return }
        try? c.handle.close()
        if let wErr { c.cont.resume(throwing: KokoroModelStore.isNoSpace(wErr) ? Failure.noSpace(KokoroModelStore.totalBytes / 4) : wErr) }
        else if let error { c.cont.resume(throwing: (error as NSError).code == NSURLErrorCancelled ? Failure.cancelled : error) }
        else if c.status != 200 && c.status != 206 { c.cont.resume(throwing: Failure.http(c.status, task.originalRequest?.url?.lastPathComponent ?? "")) }
        else { c.cont.resume() }
    }

    static func isNoSpace(_ error: Error) -> Bool {
        let ns = error as NSError
        return (ns.domain == NSCocoaErrorDomain && ns.code == NSFileWriteOutOfSpaceError) || (ns.domain == NSPOSIXErrorDomain && ns.code == Int(ENOSPC))
    }

    static func sha256(of url: URL) throws -> String {
        let h = try FileHandle(forReadingFrom: url); defer { try? h.close() }
        var hasher = SHA256()
        while let d = try h.read(upToCount: 8 << 20), !d.isEmpty { hasher.update(data: d) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
