// ModelStore.swift: first-use delivery of the Phonon-2 Core ML folder (≈ 345 MB) from Hugging Face.
//   * files pinned to one repository revision (resolve URLs), each checked against its SHA-256 from the repository's SHA256SUMS
//   * resumable: every file streams into "<name>.part" with HTTP Range requests, so a dropped connection or a killed app continues
//     where it stopped
//   * stored in Application Support/PhononModels/<revision>/, excluded from iCloud/iTunes backup
//   * compiled once with MLModel.compileModel into "<folder>/Phonon-2.mlmodelc" (the path Transcriber prefers, stable, so the
//     Neural Engine's per-path compile cache keeps hitting), after which the 332 MB .mlpackage is deleted
import CoreML
import CryptoKit
import Foundation

@available(iOS 18.0, macOS 15.0, *)
final class ModelStore: NSObject, URLSessionDataDelegate {
    static let repo = "FermionResearch/Phonon-2-CoreML"
    static let revision = "48af304c8db8bcc25307c206c199612f48479954"   // 2026-10-23
    struct Item { let path: String; let size: Int64; let sha256: String }
    static let items: [Item] = [   // sizes and SHA-256 from the repository's SHA256SUMS at `revision`
        Item(path: "manifest.json", size: 1428, sha256: "ab3fb5dfd3fc07b1d8a24379d04418f458d0443ba6359d3a5ab2f098a7d64089"),
        Item(path: "decoder.bin", size: 13301279, sha256: "36fa7202dda85c603af60d930ab88d7e9f0d2a619490aff46f5384db924cfa70"),
        Item(path: "NOTICE", size: 3084, sha256: "b468a23a1ce2c5181ea4050432bb68713a6468ce2e452927228d24f3d56226be"),
        Item(path: "LICENSE-WEIGHTS-CC-BY-4.0.txt", size: 18657, sha256: "9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411"),
        Item(path: "Phonon-2.mlpackage/Manifest.json", size: 617, sha256: "6ebc9309aea0e16bda9c7558521fef6307fac0afba9a5b4959fea45ed7cd0429"),
        Item(path: "Phonon-2.mlpackage/Data/com.apple.CoreML/model.mlmodel", size: 2500482, sha256: "4f6790ec94fe4429b10397c013563d0a51119953ff6d3da466bbcb23a25dee2a"),
        Item(path: "Phonon-2.mlpackage/Data/com.apple.CoreML/weights/weight.bin", size: 329186560, sha256: "93aa991318a00ed492fdbb724e7bca4e6a69c6cf671ab4f14a14ef6101e7648b"),
    ]
    static var totalBytes: Int64 { items.reduce(0) { $0 + max(0, $1.size) } }

    enum Failure: LocalizedError {
        case http(Int, String), checksum(String), cancelled
        var errorDescription: String? {
            switch self {
            case .http(let c, let p): return "Download of \(p) failed (HTTP \(c))."
            case .checksum(let p): return "\(p) did not match its checksum; it will be downloaded again."
            case .cancelled: return "Model download cancelled."
            }
        }
    }

    let root: URL
    var progress: ((Double, String) -> Void)?
    private var session: URLSession!
    private var current: (handle: FileHandle, done: Int64, base: Int64, cont: CheckedContinuation<Void, Error>, status: Int)?
    private let lock = NSLock()
    private var cancelled = false

    /// Application Support/PhononModels: every revision's folder lives under it ("Remove model" deletes it all).
    static var modelsDir: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("PhononModels")
    }

    /// `allowCellular` false: the download waits for Wi-Fi (no expensive or Low Data Mode networks); the OS enforces it per request,
    /// so a Wi-Fi drop mid-download pauses instead of continuing on cellular.
    init(root: URL? = nil, allowCellular: Bool = false) {
        self.root = root ?? ModelStore.modelsDir.appendingPathComponent("Phonon-2-CoreML-\(ModelStore.revision.prefix(12))")
        super.init()
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 60
        cfg.waitsForConnectivity = true
        cfg.allowsExpensiveNetworkAccess = allowCellular
        cfg.allowsConstrainedNetworkAccess = allowCellular
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }

    /// Deletes every downloaded / partial model folder.
    static func removeAll() throws {
        let fm = FileManager.default
        if fm.fileExists(atPath: modelsDir.path) { try fm.removeItem(at: modelsDir) }
    }

    /// Bytes downloaded so far (finished files + .part files), for a progress line before the next download starts.
    func bytesOnDisk() -> Int64 {
        var bytes: Int64 = 0
        if let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey]) {
            for case let u as URL in e { bytes += Int64((try? u.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
        }
        return bytes
    }

    static func url(_ path: String) -> URL {
        URL(string: "https://huggingface.co/\(repo)/resolve/\(revision)/\(path)")!
    }
    var compiledURL: URL { root.appendingPathComponent("Phonon-2.mlmodelc") }
    var readyMarker: URL { root.appendingPathComponent(".ready") }
    /// Downloaded, verified and compiled.
    var isReady: Bool { FileManager.default.fileExists(atPath: readyMarker.path) }

    func cancel() { lock.lock(); cancelled = true; lock.unlock(); session.invalidateAndCancel() }

    /// Download (or resume), verify, compile. Returns the folder to hand to `Transcriber(bundle:)`.
    func ensure() async throws -> URL {
        if isReady { return root }
        let fm = FileManager.default
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        var rv = URLResourceValues(); rv.isExcludedFromBackup = true
        var r = root; try r.setResourceValues(rv)
        let total = Double(ModelStore.totalBytes)
        var finished: Int64 = 0
        // killed after the compile moved into place but before .ready was written: the package is (being) deleted, keep the compile
        let compiled = fm.fileExists(atPath: compiledURL.path)
        for item in ModelStore.items {
            let dst = root.appendingPathComponent(item.path)
            if fm.fileExists(atPath: dst.path) { finished += max(0, item.size); continue }   // verified before it was renamed
            if compiled && item.path.hasPrefix("Phonon-2.mlpackage/") { finished += max(0, item.size); continue }
            try fm.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
            let part = dst.appendingPathExtension("part")
            var attempt = 0
            while true {
                do {
                    try await fetch(item.path, to: part) { got in self.progress?((Double(finished) + Double(got)) / total, item.path) }
                    break
                } catch Failure.cancelled { throw Failure.cancelled }
                catch {
                    attempt += 1
                    if attempt >= 5 { throw error }
                    try await Task.sleep(nanoseconds: UInt64(attempt) * 2_000_000_000)
                }
            }
            if try ModelStore.sha256(of: part) != item.sha256 { try? fm.removeItem(at: part); throw Failure.checksum(item.path) }
            try fm.moveItem(at: part, to: dst)
            finished += max(0, item.size)
        }
        progress?(1, "compiling")
        let pkg = root.appendingPathComponent("Phonon-2.mlpackage")
        if !compiled && !fm.fileExists(atPath: compiledURL.path) {
            let tmp = try await MLModel.compileModel(at: pkg)
            try? fm.removeItem(at: compiledURL)
            try fm.moveItem(at: tmp, to: compiledURL)
        }
        try? fm.removeItem(at: pkg)   // the compiled copy holds the weights; keep only one 330 MB copy on the phone
        fm.createFile(atPath: readyMarker.path, contents: Data())
        return root
    }

    /// GET with `Range: bytes=<part size>-`, appending to `part`.
    private func fetch(_ path: String, to part: URL, onBytes: @escaping (Int64) -> Void) async throws {
        let fm = FileManager.default
        if !fm.fileExists(atPath: part.path) { fm.createFile(atPath: part.path, contents: nil) }
        let have = (try? fm.attributesOfItem(atPath: part.path)[.size] as? NSNumber)?.int64Value ?? 0
        var req = URLRequest(url: ModelStore.url(path))
        if have > 0 { req.setValue("bytes=\(have)-", forHTTPHeaderField: "Range") }
        let handle = try FileHandle(forWritingTo: part)
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            lock.lock()
            if cancelled { lock.unlock(); cont.resume(throwing: Failure.cancelled); return }
            current = (handle, 0, have, cont, 0)
            lock.unlock()
            self.onBytes = onBytes
            session.dataTask(with: req).resume()
        }
    }
    private var onBytes: ((Int64) -> Void)?

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
        try? c.handle.write(contentsOf: data); c.done += Int64(data.count); current = c
        let got = c.base + c.done; lock.unlock()
        onBytes?(got)
    }
    func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); let c = current; current = nil; lock.unlock()
        guard let c else { return }
        try? c.handle.close()
        if let error { c.cont.resume(throwing: (error as NSError).code == NSURLErrorCancelled ? Failure.cancelled : error) }
        else if c.status != 200 && c.status != 206 { c.cont.resume(throwing: Failure.http(c.status, task.originalRequest?.url?.lastPathComponent ?? "")) }
        else { c.cont.resume() }
    }

    static func sha256(of url: URL) throws -> String {
        let h = try FileHandle(forReadingFrom: url); defer { try? h.close() }
        var hasher = SHA256()
        while let d = try h.read(upToCount: 8 << 20), !d.isEmpty { hasher.update(data: d) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
