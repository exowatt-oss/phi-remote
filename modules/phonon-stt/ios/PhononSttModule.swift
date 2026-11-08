// PhononSttModule.swift: Expo module for on-device live dictation with Phonon-2 (Core ML, Neural Engine).
//
// JS API (see ../index.ts):
//   isAvailable()                         iOS 18+ (Core ML multifunction models)
//   getModelStatus()                      { ready, dir, bytesOnDisk, downloadBytes, prepared, preparing, revision }
//   downloadModel({ allowCellular? })     first-use download from Hugging Face (resumable, SHA-256 checked) + compile; onProgress
//   cancelDownload()                      stop a download (the partial files stay for the next one)
//   prepare(modelDir?, options?)          load the encoder functions (first run per OS build: Neural Engine compile, minutes)
//   unload() / removeModel()              free the loaded model / delete the downloaded files too
//   start(options?)                       microphone -> live loop; onPartial { committed, tail, ... } every ~0.4 s, onLevel
//   startFile(path, options?)             the same live loop fed from a file in real time (Simulator / QA: no microphone)
//   degrade()                             stop live re-reads, keep capturing (the app's guard against a CPU fallback)
//   stop({ fullPass?, decode?, audioPath? })  final read of the open utterance (+ optional WAV of the recording); onFinal
//   cancel()                              drop the live session, no events (never touches a download)
//   transcribeFile(path)                  offline read of one file
//   getDeviceInfo() / getNetworkStatus()  memory footprint, thermal state, OS build, model / NWPathMonitor state (onNetwork)
import ExpoModulesCore
import Foundation

public class PhononSttModule: Module {
    private var box: AnyObject?   // PhononEngine (iOS 18+); stored as AnyObject so the module itself loads on any iOS
    private var network: NetworkWatch?

    @available(iOS 18.0, *)
    private var engine: PhononEngine {
        if let e = box as? PhononEngine { return e }
        let e = PhononEngine { [weak self] name, body in self?.sendEvent(name, body) }
        box = e
        return e
    }

    private func unavailable(_ promise: Promise) {
        promise.reject("ERR_PHONON_UNAVAILABLE", "iOS 18 or later is required.")
    }

    public func definition() -> ModuleDefinition {
        Name("PhononStt")
        Events("onPartial", "onFinal", "onLevel", "onProgress", "onError", "onInterrupted", "onNetwork")

        OnCreate {
            let w = NetworkWatch()
            w.onChange = { [weak self] s in self?.sendEvent("onNetwork", s) }
            self.network = w
        }

        Function("isAvailable") { () -> Bool in
            if #available(iOS 18.0, *) { return true }
            return false
        }
        Function("getModelStatus") { () -> [String: Any] in
            guard #available(iOS 18.0, *) else { return ["ready": false, "dir": "", "bytesOnDisk": 0, "prepared": false, "preparing": false] }
            return self.engine.modelStatus()
        }
        Function("getDeviceInfo") { () -> [String: Any] in DeviceStats.info() }
        Function("getNetworkStatus") { () -> [String: Any] in self.network?.status ?? ["known": false] }
        AsyncFunction("downloadModel") { (options: [String: Any]?, promise: Promise) in
            guard #available(iOS 18.0, *) else { return self.unavailable(promise) }
            self.engine.downloadModel(options: options ?? [:], promise: promise)
        }
        Function("cancelDownload") { () in
            if #available(iOS 18.0, *) { (self.box as? PhononEngine)?.cancelDownload() }
        }
        AsyncFunction("prepare") { (modelDir: String?, options: [String: Any]?, promise: Promise) in
            guard #available(iOS 18.0, *) else { return self.unavailable(promise) }
            self.engine.prepare(modelDir: modelDir, options: options ?? [:], promise: promise)
        }
        Function("unload") { () in
            if #available(iOS 18.0, *) { (self.box as? PhononEngine)?.unload() }
        }
        AsyncFunction("removeModel") { (promise: Promise) in
            guard #available(iOS 18.0, *) else { return self.unavailable(promise) }
            self.engine.removeModel(promise: promise)
        }
        AsyncFunction("start") { (options: [String: Any]?, promise: Promise) in
            guard #available(iOS 18.0, *) else { return self.unavailable(promise) }
            self.engine.startMic(options: options ?? [:], promise: promise)
        }
        AsyncFunction("startFile") { (path: String, options: [String: Any]?, promise: Promise) in
            guard #available(iOS 18.0, *) else { return self.unavailable(promise) }
            self.engine.startFile(path: path, options: options ?? [:], promise: promise)
        }
        Function("degrade") { () in
            if #available(iOS 18.0, *) { (self.box as? PhononEngine)?.degrade() }
        }
        AsyncFunction("stop") { (options: [String: Any]?, promise: Promise) in
            guard #available(iOS 18.0, *) else { return self.unavailable(promise) }
            self.engine.stop(options: options ?? [:], promise: promise)
        }
        Function("cancel") { () in
            if #available(iOS 18.0, *) { (self.box as? PhononEngine)?.cancel() }
        }
        AsyncFunction("transcribeFile") { (path: String, promise: Promise) in
            guard #available(iOS 18.0, *) else { return self.unavailable(promise) }
            self.engine.transcribeFile(path: path, promise: promise)
        }
        OnDestroy {
            if #available(iOS 18.0, *) {
                (self.box as? PhononEngine)?.cancel()
                (self.box as? PhononEngine)?.cancelDownload()
            }
        }
    }
}
