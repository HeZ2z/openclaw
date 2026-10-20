import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import { abortChatRunsForSessionKeyWithPartials } from "./chat-abort-runtime.js";
import { requireLastRespondCall } from "./chat.abort-authorization.test-helpers.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";
import type { GatewayRequestContext } from "./types.js";

const reviewMocks = vi.hoisted(() => ({
  cancelSession: vi.fn(),
  suppressRuns: vi.fn(),
}));

vi.mock("../../skills/workshop/experience-review-default.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../skills/workshop/experience-review-default.js")>()),
  cancelSkillExperienceReviewForSession: reviewMocks.cancelSession,
  suppressSkillExperienceReviewRuns: reviewMocks.suppressRuns,
}));

vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async () => ({
    entry: { sessionId: "main-session" },
    storePath: "/synthetic/experience-review/sessions.json",
  }),
}));

const sessionKey = "agent:main:main";
const storeScope = "/synthetic/experience-review/sessions.json";

function createRun(runId: string, queued = false) {
  return createActiveRun(sessionKey, {
    sessionId: "main-session",
    agentId: "main",
    storeScope,
    queued,
    runId,
  });
}

beforeEach(() => {
  reviewMocks.cancelSession.mockReset();
  reviewMocks.suppressRuns.mockReset();
});

describe("explicit chat Stop covers Workshop Experience Review", () => {
  it("cancels the review and suppresses the exact selected run for a plain chat.abort", async () => {
    const runId = "review-stop-run";
    const run = createRun(runId);
    const context = createChatAbortContext({ sources: [[runId, run]] });

    const respond = await invokeChatAbortHandler({
      handler: handleChatAbortRequestWithLifecycle,
      context,
      request: { sessionKey },
      client: { connect: { scopes: ["operator.admin"] } },
    });

    expect(requireLastRespondCall(respond)[0]).toBe(true);
    expect(reviewMocks.cancelSession).toHaveBeenCalledOnce();
    expect(reviewMocks.cancelSession).toHaveBeenCalledWith({ agentId: "main", sessionKey });
    expect(reviewMocks.suppressRuns).toHaveBeenCalledOnce();
    expect(Array.from(reviewMocks.suppressRuns.mock.calls[0]![0])).toContain(runId);
    expect(run.input.abortSignal.aborted).toBe(true);
  });

  it("keeps a throwing review binding from changing the abort result", async () => {
    const runId = "review-stop-throws";
    const run = createRun(runId);
    const context = createChatAbortContext({ sources: [[runId, run]] });
    reviewMocks.cancelSession.mockImplementation(() => {
      throw new Error("review cancellation failed");
    });
    reviewMocks.suppressRuns.mockImplementation(() => {
      throw new Error("review suppression failed");
    });

    const respond = await invokeChatAbortHandler({
      handler: handleChatAbortRequestWithLifecycle,
      context,
      request: { sessionKey },
      client: { connect: { scopes: ["operator.admin"] } },
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ ok: true, aborted: true, runIds: [runId] });
    expect(run.input.abortSignal.aborted).toBe(true);
  });

  it("does not touch reviews for queued-input discard", async () => {
    const runId = "review-discard-run";
    const run = createRun(runId, true);
    const context = createChatAbortContext({ sources: [[runId, run]] });

    const respond = await invokeChatAbortHandler({
      handler: handleChatAbortRequestWithLifecycle,
      context,
      request: { sessionKey, runId, discardPendingInput: true },
      client: { connect: { scopes: ["operator.admin"] } },
    });

    expect(requireLastRespondCall(respond)[0]).toBe(true);
    expect(reviewMocks.cancelSession).not.toHaveBeenCalled();
    expect(reviewMocks.suppressRuns).not.toHaveBeenCalled();
  });

  it("does not touch reviews for a maintenance abort without the explicit-stop flag", async () => {
    const runId = "review-maintenance-run";
    const run = createRun(runId);
    const context = createChatAbortContext({ sources: [[runId, run]] });

    const result = await abortChatRunsForSessionKeyWithPartials({
      // The synthetic fixture carries only the abort fields this path reads.
      context: context as unknown as GatewayRequestContext,
      ops: createChatAbortOps(context),
      sessionKey,
      agentId: "main",
      abortOrigin: "rpc",
      stopReason: "archive",
      stopSource: "mutation",
      requester: { isAdmin: true },
    });

    expect(result.aborted).toBe(true);
    expect(reviewMocks.cancelSession).not.toHaveBeenCalled();
    expect(reviewMocks.suppressRuns).not.toHaveBeenCalled();
  });
});
