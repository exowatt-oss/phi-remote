// Ported from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md):
// t3code/apps/mobile/src/features/voice-input/voiceInputSession.test.ts. Kept in T3's formatting so it diffs cleanly against upstream.
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { PreparedVoiceTranscription } from "../transcription";
import { resetVoiceInputGlobalsForTests } from "../controller";

import {
  createVoiceInputTarget,
  VoiceInputSession,
  type VoiceInputTarget,
} from "../session";

function createDraftRegistry(initial: string) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: (_key: string) => value,
    set: (_key: string, next: string) => {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (_key: string, listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function createTarget(
  ownerKey: string,
  readText: () => string | null,
  commit: VoiceInputTarget["commitDraft"],
  selection: { start: number; end: number },
) {
  return createVoiceInputTarget(ownerKey, readText, commit, selection, () => () => {});
}

function createSession() {
  const recorder = {
    uri: "file:///voice.m4a",
    prepareToRecordAsync: jest.fn(async () => {}),
    record: jest.fn(),
    stop: jest.fn(async () => {}),
  };
  const prepare = jest.fn(async (): Promise<PreparedVoiceTranscription> => ({
    locale: "en-US",
    transcribe: async () => "spoken text",
  }));
  const session = new VoiceInputSession({
    recorder,
    getTranscriber: () => ({ prepare }),
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => {},
    releaseRecording: jest.fn(async () => {}),
    deleteRecording: jest.fn(),
    onStateChange: jest.fn(),
  });
  return { session, recorder, prepare };
}

describe("global voice input", () => {
  beforeEach(() => resetVoiceInputGlobalsForTests());

  it.each([
    { selection: { start: 6, end: 11 }, expected: "hello spoken text", cursor: 17 },
    { selection: { start: 6, end: 6 }, expected: "hello spoken text world", cursor: 18 },
  ])(
    "keeps the starting selection $selection after navigation",
    async ({ selection, expected, cursor }) => {
      const { session } = createSession();
      const commit = jest.fn();
      await session.start(createTarget("first", () => "hello world", commit, selection));
      await session.start(
        createTarget("second", () => "other prompt", jest.fn(), { start: 12, end: 12 }),
      );
      await session.controller.stop();
      expect(commit).toHaveBeenCalledWith(expected, {
        start: cursor,
        end: cursor,
      });
    },
  );

  it("appends to the starting draft after its screen leaves and another draft opens", async () => {
    const { session, recorder } = createSession();
    const drafts = new Map([
      ["first", "original prompt"],
      ["second", "other prompt"],
    ]);
    let visibleDraft = "first";
    const targetKey = visibleDraft;
    await session.start(
      createTarget(
        targetKey,
        () => drafts.get(targetKey) ?? null,
        (text) => drafts.set(targetKey, text),
        { start: 15, end: 15 },
      ),
    );
    visibleDraft = "second";
    expect(session.controller.currentState.phase).toBe("recording");
    expect(recorder.stop).not.toHaveBeenCalled();
    await session.controller.stop();

    expect(drafts.get("first")).toBe("original prompt spoken text");
    expect(drafts.get(visibleDraft)).toBe("other prompt");
    expect(session.controller.currentState.phase).toBe("idle");
  });

  it.each(["preparing", "recording", "transcribing"] as const)(
    "keeps one recorder and its original target during %s",
    async (phase) => {
      const preparation = Promise.withResolvers<PreparedVoiceTranscription>();
      const preparationEntered = Promise.withResolvers<void>();
      const transcription = Promise.withResolvers<string>();
      const transcriptionEntered = Promise.withResolvers<void>();
      const { session, recorder, prepare } = createSession();
      prepare.mockImplementationOnce(() => {
        preparationEntered.resolve();
        return preparation.promise;
      });
      const firstCommit = jest.fn();
      const secondCommit = jest.fn();
      const starting = session.start(
        createTarget("first", () => "first", firstCommit, { start: 5, end: 5 }),
      );
      await preparationEntered.promise;
      let stopping: Promise<void> | null = null;
      if (phase !== "preparing") {
        preparation.resolve({
          locale: "en-US",
          transcribe: () => {
            transcriptionEntered.resolve();
            return transcription.promise;
          },
        });
        await starting;
      }
      if (phase === "transcribing") {
        stopping = session.controller.stop();
        await transcriptionEntered.promise;
      }
      await session.start(
        createTarget("second", () => "second", secondCommit, { start: 6, end: 6 }),
      );
      expect(session.ownerKey).toBe("first");
      expect(session.controller.currentState.phase).toBe(phase);
      expect(prepare).toHaveBeenCalledTimes(1);
      preparation.resolve({ locale: "en-US", transcribe: async () => "spoken text" });
      await starting;
      transcription.resolve("spoken text");
      await (stopping ?? session.controller.stop());
      expect(recorder.record).toHaveBeenCalledTimes(1);
      expect(firstCommit).toHaveBeenCalledWith("first spoken text", { start: 17, end: 17 });
      expect(secondCommit).not.toHaveBeenCalled();
    },
  );

  it.each(["changed", "removed"] as const)(
    "does not overwrite a %s starting draft",
    async (change) => {
      const { session } = createSession();
      let text: string | null = "first";
      const commit = jest.fn();
      await session.start(createTarget("first", () => text, commit, { start: 5, end: 5 }));
      text = change === "removed" ? null : "edited prompt";
      await session.controller.stop();
      expect(commit).not.toHaveBeenCalled();
      expect(session.controller.currentState.error).toContain("draft changed");
    },
  );

  it("finishes the original draft at the recording limit while it is off screen", async () => {
    const { session, recorder } = createSession();
    const commit = jest.fn();
    await session.start(createTarget("first", () => "first", commit, { start: 5, end: 5 }));
    await session.controller.handleRecorderStatus({
      isFinished: true,
      hasError: false,
      error: null,
      url: recorder.uri,
    });
    expect(commit).toHaveBeenCalledWith("first spoken text", { start: 17, end: 17 });
    expect(session.controller.currentState.phase).toBe("idle");
  });

  it("rejects a transcript when its off-screen draft changes and returns to the original text", async () => {
    // T3 uses an effect Atom registry here; a minimal observable value is equivalent.
    const registry = createDraftRegistry("hello world");
    const draft = "draft";
    const unsubscribe = jest.fn();
    const { session } = createSession();
    const commit = jest.fn();
    const target = createVoiceInputTarget(
      "first",
      () => registry.get(draft),
      commit,
      { start: 6, end: 6 },
      (onChange) => {
        const stop = registry.subscribe(draft, onChange);
        return () => {
          stop();
          unsubscribe();
        };
      },
    );
    await session.start(target);
    registry.set(draft, "changed");
    registry.set(draft, "hello world");
    await session.controller.stop();
    expect(commit).not.toHaveBeenCalled();
    expect(session.controller.currentState.error).toContain("draft changed");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("stops recording when its queued edit is discarded", async () => {
    const { session, recorder } = createSession();
    const commit = jest.fn();
    let draft: string | null = "queued prompt";
    const ownerKey = "thread~queued-edit~run";
    await session.start(createTarget(ownerKey, () => draft, commit, { start: 13, end: 13 }));
    session.cancel(ownerKey);
    draft = null;
    await session.controller.stop();
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(session.controller.currentState).toEqual({
      phase: "idle",
      error: null,
      errorAction: null,
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it.each(["complete", "cancel"] as const)(
    "releases draft observation after %s",
    async (finish) => {
      const { session } = createSession();
      const unsubscribe = jest.fn();
      const subscribe = jest.fn(() => unsubscribe);
      await session.start(
        createVoiceInputTarget("first", () => "first", jest.fn(), { start: 5, end: 5 }, subscribe),
      );
      expect(subscribe).toHaveBeenCalledTimes(1);
      if (finish === "complete") await session.controller.stop();
      else session.cancel("first");
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps another prompt's recording when a queued edit is discarded", async () => {
    const { session, recorder } = createSession();
    const commit = jest.fn();
    await session.start(createTarget("other prompt", () => "hello", commit, { start: 5, end: 5 }));
    session.cancel("thread~queued-edit~run");
    expect(recorder.stop).not.toHaveBeenCalled();
    expect(session.controller.currentState.phase).toBe("recording");
    await session.controller.stop();
    expect(commit).toHaveBeenCalledWith("hello spoken text", { start: 17, end: 17 });
  });

  it("waits for canceled native work before starting a recording for another draft", async () => {
    const preparation = Promise.withResolvers<PreparedVoiceTranscription>();
    const preparationEntered = Promise.withResolvers<void>();
    const { session, recorder, prepare } = createSession();
    prepare.mockImplementationOnce(() => {
      preparationEntered.resolve();
      return preparation.promise;
    });
    const oldCommit = jest.fn();
    const nextCommit = jest.fn();
    const firstStart = session.start(
      createTarget("first", () => "first", oldCommit, { start: 5, end: 5 }),
    );
    await preparationEntered.promise;
    session.cancel("first");
    const nextStart = session.start(
      createTarget("second", () => "second", nextCommit, { start: 6, end: 6 }),
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(recorder.record).not.toHaveBeenCalled();
    preparation.resolve({ locale: "en-US", transcribe: async () => "old transcript" });
    await firstStart;
    await nextStart;
    await session.controller.stop();
    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(oldCommit).not.toHaveBeenCalled();
    expect(nextCommit).toHaveBeenCalledWith("second spoken text", { start: 18, end: 18 });
  });
});
