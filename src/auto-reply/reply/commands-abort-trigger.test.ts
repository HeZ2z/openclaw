// Tests abort trigger command parsing and cancellation requests.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { handleAbortTrigger } from "./commands-session-abort.js";
import type { HandleCommandsParams } from "./commands-types.js";

const persistAbortTargetEntryMock = vi.hoisted(() => vi.fn());
const resolveCommandSessionEntryForKeyMock = vi.hoisted(() =>
  vi.fn(() => ({ entry: undefined, key: "agent:main:main" })),
);
const setAbortMemoryMock = vi.hoisted(() => vi.fn());
const stopSessionMock = vi.hoisted(() => vi.fn());
const cancelSkillExperienceReviewForSessionMock = vi.hoisted(() => vi.fn());
const suppressSkillExperienceReviewRunsMock = vi.hoisted(() => vi.fn());

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(),
}));

vi.mock("./abort-cutoff.js", () => ({
  resolveAbortCutoffFromContext: vi.fn(() => undefined),
  shouldPersistAbortCutoff: vi.fn(() => false),
}));

vi.mock("./abort-operation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./abort-operation.js")>()),
  captureChannelSessionStop: vi.fn(
    (params: { key?: string; sessionId?: string; agentId?: string }) => ({
      ...params,
      sessionKey: params.key,
      requestRunIds: new Set(["run-1"]),
    }),
  ),
  stopSubagentsForRequester: vi.fn(async () => ({ stopped: 0, failed: 0 })),
}));

// mock-isolation: Run the real Stop kernel bridge against a captured fake Stop execution.
vi.mock("../../sessions/session-controller.stop.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/session-controller.stop.js")>()),
  stopSession: stopSessionMock,
}));

vi.mock("./abort-trigger-text.js", () => ({
  isAbortTrigger: vi.fn((raw: string) => raw === "stop"),
}));

vi.mock("./abort-primitives.js", () => ({
  setAbortMemory: setAbortMemoryMock,
}));

vi.mock("./commands-session-store.js", () => ({
  persistAbortTargetEntry: persistAbortTargetEntryMock,
  resolveCommandSessionEntryForKey: resolveCommandSessionEntryForKeyMock,
}));

// mock-isolation: Observe the stop-bound experience-review cancellation without starting real work.
vi.mock("../../skills/workshop/experience-review-default.js", () => ({
  cancelSkillExperienceReviewForSession: cancelSkillExperienceReviewForSessionMock,
  suppressSkillExperienceReviewRuns: suppressSkillExperienceReviewRunsMock,
}));

function buildAbortParams(): HandleCommandsParams {
  return {
    cfg: {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig,
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
    },
    command: {
      commandBodyNormalized: "stop",
      rawBodyNormalized: "stop",
      isAuthorizedSender: false,
      senderIsOwner: false,
      senderId: "unauthorized",
      channel: "whatsapp",
      channelId: "whatsapp",
      surface: "whatsapp",
      ownerList: [],
      from: "unauthorized",
      to: "bot",
    },
    sessionKey: "agent:main:main",
    sessionEntry: {
      sessionId: "session-1",
      updatedAt: Date.now(),
      abortedLastRun: false,
    },
    sessionStore: {
      "agent:main:main": {
        sessionId: "session-1",
        updatedAt: Date.now(),
        abortedLastRun: false,
      },
    },
  } as unknown as HandleCommandsParams;
}

type FakeStopRequest = {
  capture: () => unknown;
  recordAbortTarget?: (options: { recordCutoff: boolean }) => Promise<void>;
};

function fakeStopOutcome(overrides: { alreadyFinalizing?: boolean } = {}) {
  return {
    aborted: false,
    alreadyFinalizing: overrides.alreadyFinalizing ?? false,
    queuedCancelled: 0,
    activeCancelled: 0,
    childrenStopped: 0,
    childFailures: 0,
    failures: [],
    settled: Promise.resolve(),
  };
}

function mockStopExecution(request: FakeStopRequest, outcome: ReturnType<typeof fakeStopOutcome>) {
  return {
    ...outcome,
    completed: (async () => {
      // Resolve the capture exactly like the real owner, which runs the review bridge.
      request.capture();
      // The real Stop owner skips abort metadata while the run is already finalizing.
      if (!outcome.alreadyFinalizing) {
        await request.recordAbortTarget?.({ recordCutoff: false });
      }
      return outcome;
    })(),
  };
}

describe("handleAbortTrigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopSessionMock.mockImplementation((request: FakeStopRequest) =>
      mockStopExecution(request, fakeStopOutcome()),
    );
  });

  it("rejects unauthorized natural-language abort triggers", async () => {
    const result = await handleAbortTrigger(buildAbortParams(), true);
    expect(result?.shouldContinue).toBe(false);
    expect(stopSessionMock).not.toHaveBeenCalled();
    expect(persistAbortTargetEntryMock).not.toHaveBeenCalled();
    expect(setAbortMemoryMock).not.toHaveBeenCalled();
  });

  it("reports a finalizing run without persisting abort state", async () => {
    const params = buildAbortParams();
    params.command.isAuthorizedSender = true;
    params.command.senderIsOwner = true;
    stopSessionMock.mockImplementation((request: FakeStopRequest) =>
      mockStopExecution(request, fakeStopOutcome({ alreadyFinalizing: true })),
    );
    const result = await handleAbortTrigger(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Agent reply is already finalizing and can no longer be aborted." },
    });
    expect(stopSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hookContext: expect.objectContaining({
          sessionKey: "agent:main:main",
          commandSource: "whatsapp",
          senderId: "unauthorized",
        }),
      }),
    );
    expect(persistAbortTargetEntryMock).not.toHaveBeenCalled();
    expect(setAbortMemoryMock).not.toHaveBeenCalled();
    expect(cancelSkillExperienceReviewForSessionMock).toHaveBeenCalledExactlyOnceWith({
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    expect(suppressSkillExperienceReviewRunsMock).toHaveBeenCalledExactlyOnceWith(
      new Set(["run-1"]),
    );
  });

  it("does not fail the stop when review cancellation throws", async () => {
    const params = buildAbortParams();
    params.command.isAuthorizedSender = true;
    params.command.senderIsOwner = true;
    cancelSkillExperienceReviewForSessionMock.mockImplementationOnce(() => {
      throw new Error("review cancellation failed");
    });

    const result = await handleAbortTrigger(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(stopSessionMock).toHaveBeenCalledOnce();
    // The two best-effort calls are independent: suppression still covers agent_end.
    expect(suppressSkillExperienceReviewRunsMock).toHaveBeenCalledOnce();
  });

  it("does not fail the stop when run suppression throws", async () => {
    const params = buildAbortParams();
    params.command.isAuthorizedSender = true;
    params.command.senderIsOwner = true;
    suppressSkillExperienceReviewRunsMock.mockImplementationOnce(() => {
      throw new Error("review suppression failed");
    });

    const result = await handleAbortTrigger(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(cancelSkillExperienceReviewForSessionMock).toHaveBeenCalledOnce();
    expect(stopSessionMock).toHaveBeenCalledOnce();
  });
});
