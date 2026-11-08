// DeviceStats.swift: numbers for the "Live dictation details" screen (no device logs needed on a real iPhone):
// the app's physical memory footprint (task_vm_info.phys_footprint, what jetsam counts), the thermal state, the OS version and build
// (the Neural Engine compile cache is keyed on the OS build), the hardware model; plus a 16-bit WAV writer for the fallback path.
import Foundation
import Network

enum DeviceStats {
    /// Physical footprint of this process in MB (0 when unavailable).
    static func footprintMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return kr == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : 0
    }

    static func thermalState() -> String {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }

    /// "iPhone17,2" style hardware identifier ("arm64" / "x86_64" in the Simulator).
    static func hardwareModel() -> String {
        if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return "\(sim) (Simulator)" }
        var u = utsname(); uname(&u)
        return withUnsafeBytes(of: &u.machine) { raw in String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self) }
    }

    static func info() -> [String: Any] {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return ["footprintMB": footprintMB(), "thermalState": thermalState(),
                "osVersion": "\(v.majorVersion).\(v.minorVersion)" + (v.patchVersion > 0 ? ".\(v.patchVersion)" : ""),
                "osVersionString": ProcessInfo.processInfo.operatingSystemVersionString, "model": hardwareModel(),
                "lowPowerMode": ProcessInfo.processInfo.isLowPowerModeEnabled]
    }

    /// Mono 16 kHz float samples -> 16-bit PCM WAV (what SpeechAnalyzer reads when live dictation falls back mid-session).
    static func writeWAV(_ samples: [Float], sampleRate: Int, to url: URL) throws {
        var data = Data(capacity: 44 + samples.count * 2)
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        let bytes = UInt32(samples.count * 2)
        data.append(contentsOf: Array("RIFF".utf8)); u32(36 + bytes); data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 2)); u16(2); u16(16)
        data.append(contentsOf: Array("data".utf8)); u32(bytes)
        var pcm = [Int16](repeating: 0, count: samples.count)
        for i in 0..<samples.count { pcm[i] = Int16(max(-1, min(1, samples[i])) * 32767) }
        pcm.withUnsafeBytes { data.append(contentsOf: $0) }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }
}

/// NWPathMonitor: whether a network is up and whether it is "expensive" (cellular, personal hotspot) or "constrained" (Low Data
/// Mode). The model download waits for an inexpensive, unconstrained path unless the user allows cellular.
final class NetworkWatch {
    private let monitor = NWPathMonitor()
    private let lock = NSLock()
    private var last: [String: Any]?
    var onChange: (([String: Any]) -> Void)?

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let s: [String: Any] = ["connected": path.status == .satisfied, "expensive": path.isExpensive, "constrained": path.isConstrained,
                                    "wifi": path.usesInterfaceType(.wifi), "cellular": path.usesInterfaceType(.cellular)]
            guard let self else { return }
            self.lock.lock(); self.last = s; self.lock.unlock()
            self.onChange?(s)
        }
        monitor.start(queue: DispatchQueue(label: "phonon.network", qos: .utility))
    }
    var status: [String: Any]? { lock.lock(); defer { lock.unlock() }; return last }
    deinit { monitor.cancel() }
}
