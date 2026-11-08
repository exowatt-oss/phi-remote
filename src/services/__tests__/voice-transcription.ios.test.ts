// Ported from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md):
// t3code/apps/mobile/src/native/voiceTranscription.ios.test.ts. Kept in T3's formatting so it diffs cleanly against upstream.
import type { TranscriptionResult } from "@react-native-ai/apple/src/NativeAppleTranscription";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

import { VoiceTranscriptionError } from "@/lib/voice-input";

import { getLocalVoiceTranscriber } from "../voice-transcription.ios"; // jest.mock calls below are hoisted above it

// vitest `vi.hoisted` → jest: factories may only reference `mock`-prefixed variables.
const mockNative = {
  isAvailable: jest.fn<(locale: string) => boolean>(),
  prepare: jest.fn<(locale: string) => Promise<string>>(),
  transcribe: jest.fn<(audio: ArrayBufferLike, locale: string, strings?: string[]) => Promise<TranscriptionResult>>(),
  readAudio: jest.fn<() => Promise<ArrayBuffer>>(),
};
const mocks = mockNative;

jest.mock("@react-native-ai/apple/src/NativeAppleTranscription", () => ({
  __esModule: true,
  default: {
    isAvailable: (locale: string) => mockNative.isAvailable(locale),
    prepare: (locale: string) => mockNative.prepare(locale),
    transcribe: (audio: ArrayBufferLike, locale: string, ...strings: string[][]) =>
      mockNative.transcribe(audio, locale, ...strings),
  },
}));

jest.mock("expo-file-system", () => ({
  File: class {
    arrayBuffer = () => mockNative.readAudio();
  },
}));

const audio = new ArrayBuffer(4);
const nativeTranscript: TranscriptionResult = {
  duration: 2,
  segments: [
    { text: " Hej", startSecond: 0, endSecond: 1 },
    { text: "världen. ", startSecond: 1, endSecond: 2 },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.resetAllMocks();
  mocks.isAvailable.mockReturnValue(true);
  mocks.prepare.mockResolvedValue("sv-SE");
  mocks.readAudio.mockResolvedValue(audio);
  mocks.transcribe.mockResolvedValue(nativeTranscript);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("getLocalVoiceTranscriber", () => {
  it("keeps the selected language and Apple's resolved locale when the device language changes", async () => {
    const resolvedOptions = Intl.DateTimeFormat().resolvedOptions();
    const deviceLocale = jest
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ ...resolvedOptions, locale: "sv-FI" });
    const transcriber = getLocalVoiceTranscriber()!;
    const options = { signal: new AbortController().signal };

    deviceLocale.mockReturnValue({ ...resolvedOptions, locale: "de-DE" });
    const prepared = await transcriber.prepare(options);
    deviceLocale.mockReturnValue({ ...resolvedOptions, locale: "en-US" });

    await expect(prepared.transcribe("file:///voice.m4a", options)).resolves.toBe("Hej världen.");
    expect(mocks.prepare).toHaveBeenCalledWith("sv-FI");
    expect(prepared.locale).toBe("sv-SE");
    expect(mocks.transcribe).toHaveBeenCalledWith(audio, "sv-SE");
  });

  // phi remote: the dictation dictionary's words go to SpeechAnalyzer as contextual strings.
  it("passes contextual strings, read when each recording is transcribed", async () => {
    let strings = ["Jev", "phi"];
    const options = { signal: new AbortController().signal };
    const prepared = await getLocalVoiceTranscriber(() => strings)!.prepare(options);
    strings = ["Jev", "phi", "ExampleCo"];
    await prepared.transcribe("file:///voice.m4a", options);
    expect(mocks.transcribe).toHaveBeenCalledWith(audio, "sv-SE", ["Jev", "phi", "ExampleCo"]);

    mocks.transcribe.mockClear();
    strings = [];
    await prepared.transcribe("file:///voice.m4a", options);
    expect(mocks.transcribe).toHaveBeenCalledWith(audio, "sv-SE");
  });

  it("does not start native transcription after cancellation during a file read", async () => {
    const enteredRead = deferred<void>();
    const readResult = deferred<ArrayBuffer>();
    mocks.readAudio.mockImplementation(() => {
      enteredRead.resolve();
      return readResult.promise;
    });
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const prepared = await getLocalVoiceTranscriber()!.prepare(options);
    const result = prepared
      .transcribe("file:///voice.m4a", options)
      .catch((error: unknown) => error);

    await enteredRead.promise;
    controller.abort();
    readResult.resolve(audio);

    const error = await result;
    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    expect(error).toMatchObject({ code: "cancelled" });
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  it.each(["prepare", "transcribe"] as const)(
    "waits for native %s to finish before settling cancellation",
    async (phase) => {
      const enteredNative = deferred<void>();
      const finishNative = deferred<void>();
      if (phase === "prepare") {
        mocks.prepare.mockImplementation(async () => {
          enteredNative.resolve();
          await finishNative.promise;
          return "sv-SE";
        });
      } else {
        mocks.transcribe.mockImplementation(async () => {
          enteredNative.resolve();
          await finishNative.promise;
          return nativeTranscript;
        });
      }
      const controller = new AbortController();
      const options = { signal: controller.signal };
      const transcriber = getLocalVoiceTranscriber()!;
      const operation =
        phase === "prepare"
          ? transcriber.prepare(options)
          : (await transcriber.prepare(options)).transcribe("file:///voice.m4a", options);
      const settled = jest.fn((value: unknown) => value);
      const result = operation.then(settled, settled);

      await enteredNative.promise;
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).not.toHaveBeenCalled();
      finishNative.resolve();

      const error = await result;
      expect(error).toBeInstanceOf(VoiceTranscriptionError);
      expect(error).toMatchObject({ code: "cancelled" });
    },
  );
});
