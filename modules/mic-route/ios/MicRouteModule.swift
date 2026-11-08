// MicRouteModule.swift: which microphone dictation records from.
//
// iOS gives a play-and-record session the most recently connected input: a wired headset's mic, or, when the category
// allows Bluetooth HFP, the Bluetooth headset's mic (and the headphones then drop to call-quality audio). The app's
// recording session leaves HFP out unless the user chose "Headset" (patched expo-audio `allowsBluetoothHFP`), and
// prefer("iphone") selects the built-in mic with setPreferredInput, then selects it again after every route change until
// release(), so headphones connecting mid-dictation cannot take the input. prefer("headset") selects the headset's mic
// instead. When no such port exists (no built-in mic, no headset), iOS's own choice stays.
//
// JS API (../index.ts): prefer(mic) / release() resolve with a route report; onRouteChange(report) after each route change.
// Each report is also logged (subsystem com.example.phiremote, category mic-route, level info; port names private).
import AVFoundation
import ExpoModulesCore
import os

public class MicRouteModule: Module {
    private let queue = DispatchQueue(label: "com.example.phiremote.mic-route")
    /// "iphone" or "headset" while a dictation holds the microphone; nil otherwise. Only touched on `queue`.
    private var wanted: String?
    private var observer: NSObjectProtocol?
    private static let log = Logger(subsystem: "com.example.phiremote", category: "mic-route")

    public func definition() -> ModuleDefinition {
        Name("MicRoute")
        Events("onRouteChange")

        AsyncFunction("prefer") { (mic: String) -> [String: Any] in
            return self.queue.sync { () -> [String: Any] in
                self.wanted = mic == "headset" ? "headset" : "iphone"
                self.watch()
                return self.apply(reason: "prefer")
            }
        }
        AsyncFunction("release") { () -> [String: Any] in
            return self.queue.sync { () -> [String: Any] in
                self.unwatch()
                let held = self.wanted != nil
                self.wanted = nil
                var failure: String?
                if held {
                    do { try AVAudioSession.sharedInstance().setPreferredInput(nil) } catch { failure = error.localizedDescription }
                }
                return self.report(reason: "release", action: held ? "cleared" : "none", error: failure)
            }
        }
        OnDestroy {
            self.queue.sync {
                self.unwatch()
                self.wanted = nil
            }
        }
    }

    /// The input `mic` asks for among `inputs`: the built-in mic, or a headset's (Bluetooth, then wired, then USB, then any other).
    static func port(for mic: String, in inputs: [AVAudioSessionPortDescription]) -> AVAudioSessionPortDescription? {
        if mic == "headset" {
            for type in [AVAudioSession.Port.bluetoothHFP, .headsetMic, .usbAudio] {
                if let p = inputs.first(where: { $0.portType == type }) { return p }
            }
            return inputs.first { $0.portType != .builtInMic }
        }
        return inputs.first { $0.portType == .builtInMic }
    }

    /// Selects the wanted input unless the route already uses it. On `queue`.
    private func apply(reason: String) -> [String: Any] {
        guard let mic = wanted else { return report(reason: reason, action: "none", error: nil) }
        let session = AVAudioSession.sharedInstance()
        guard let port = MicRouteModule.port(for: mic, in: session.availableInputs ?? []) else {
            return report(reason: reason, action: "system", error: nil)   // nothing to choose: iOS decides
        }
        if session.currentRoute.inputs.first?.uid == port.uid && session.preferredInput?.uid == port.uid {
            return report(reason: reason, action: "kept", error: nil)
        }
        do {
            try session.setPreferredInput(port)
            return report(reason: reason, action: "selected", error: nil)
        } catch {
            return report(reason: reason, action: "failed", error: error.localizedDescription)
        }
    }

    private func watch() {
        guard observer == nil else { return }
        observer = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil
        ) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            let why = MicRouteModule.reasonName(raw.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:)))
            self?.queue.async {
                guard let self, self.wanted != nil else { return }
                self.sendEvent("onRouteChange", self.apply(reason: "route-change:\(why)"))
            }
        }
    }

    private func unwatch() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
    }

    private func report(reason: String, action: String, error: String?) -> [String: Any] {
        let session = AVAudioSession.sharedInstance()
        let input = session.currentRoute.inputs.first
        let outputs = session.currentRoute.outputs
        var out: [String: Any] = [
            "mic": orNull(wanted),
            "reason": reason,
            "action": action,
            "input": orNull(input.map(MicRouteModule.describe)),
            "outputs": outputs.map(MicRouteModule.describe),
            "preferred": orNull(session.preferredInput.map(MicRouteModule.describe)),
            "available": (session.availableInputs ?? []).map(MicRouteModule.describe),
            "category": session.category.rawValue,
            "options": MicRouteModule.optionNames(session.categoryOptions),
        ]
        if let error { out["error"] = error }
        let mic = wanted ?? "none"
        let inType = input?.portType.rawValue ?? "none"
        let inName = input?.portName ?? ""
        let outTypes = outputs.map { $0.portType.rawValue }.joined(separator: ",")
        let available = (session.availableInputs ?? []).map { $0.portType.rawValue }.joined(separator: ",")
        let options = MicRouteModule.optionNames(session.categoryOptions).joined(separator: ",")
        MicRouteModule.log.info(
            "mic=\(mic, privacy: .public) \(reason, privacy: .public) \(action, privacy: .public): input=\(inType, privacy: .public) \"\(inName, privacy: .private)\" outputs=\(outTypes, privacy: .public) available=\(available, privacy: .public) options=\(options, privacy: .public) \(error ?? "", privacy: .public)"
        )
        return out
    }

    private func orNull(_ value: Any?) -> Any { value ?? NSNull() }

    private static func describe(_ port: AVAudioSessionPortDescription) -> [String: Any] {
        ["type": port.portType.rawValue, "name": port.portName, "uid": port.uid]
    }

    /// The category options that decide the route: Bluetooth HFP lets a headset take the input; A2DP keeps output on headphones.
    private static func optionNames(_ o: AVAudioSession.CategoryOptions) -> [String] {
        var names: [String] = []
        if o.contains(.allowBluetoothHFP) { names.append("allowBluetoothHFP") }
        if o.contains(.allowBluetoothA2DP) { names.append("allowBluetoothA2DP") }
        if o.contains(.defaultToSpeaker) { names.append("defaultToSpeaker") }
        if o.contains(.mixWithOthers) { names.append("mixWithOthers") }
        if o.contains(.duckOthers) { names.append("duckOthers") }
        return names
    }

    private static func reasonName(_ reason: AVAudioSession.RouteChangeReason?) -> String {
        switch reason {
        case .newDeviceAvailable: return "new-device"
        case .oldDeviceUnavailable: return "device-gone"
        case .categoryChange: return "category"
        case .override: return "override"
        case .wakeFromSleep: return "wake"
        case .noSuitableRouteForCategory: return "no-route"
        case .routeConfigurationChange: return "configuration"
        default: return "unknown"
        }
    }
}
