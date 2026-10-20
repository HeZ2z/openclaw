import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import {
  canSettleInterruptedUpdate,
  persistInterruptedUpdateObservation,
} from "../infra/update-run-interruption-store.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../infra/update-run-ledger.js";
import { renderUpdateRunNotice, renderUpdateRunSummary } from "../infra/update-run-notice.js";
import { reconcileUpdateRunsInNativeKernelForTest } from "../infra/update-run-reconciliation.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createUpdateRunNotifier } from "./update-run-notice.runtime.js";

describe("host-owned update notices", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-update-notice-" });
    await captureRuntimeConfigAsyncReader()();
  });
  afterEach(async () => {
    await state.cleanup();
  });

  it.each(["succeeded", "failed"] as const)(
    "keeps %s notices concise and saves diagnostic details",
    async (status) => {
      const target = {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "update-session",
        storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const advice =
        "Managed gateway remains stopped. Keep the gateway stopped until the update succeeds.";
      const warning = "gateway.auth.token is SecretRef-managed; verify the daemon runtime context.";
      const initial = createUpdateRun({
        trigger: "chat",
        origin: { sessionKey: target.sessionKey, nextAction: advice },
      });
      recordUpdateRunStep(initial.runId, {
        step: "warning:gateway-auth",
        status: "completed",
        detail: warning,
      });
      recordUpdateRunVerification(initial.runId, { port: 19123, versionMatch: false });
      const finished = finishUpdateRun(initial.runId, {
        status,
        ...(status === "failed" ? { reason: "restart-unhealthy" } : {}),
      });
      if (!finished) {
        throw new Error("Missing finished update");
      }

      const notify = await createUpdateRunNotifier(initial, () => ({}), {});
      expect(await notify(finished, "finished")).toEqual({
        delivered: true,
        owned: true,
      });

      const messages = (await loadTranscriptEvents(target)).filter(
        (event) => asOptionalRecord(event)?.type === "message",
      );
      const headline =
        status === "failed" ? "⚠️ OpenClaw couldn't finish updating." : "✅ OpenClaw updated.";
      expect(messages).toMatchObject([
        {
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `${headline}\nFor details, open Settings → Updates in the Control UI or run \`openclaw update status\` in your terminal.`,
              },
            ],
          },
        },
      ]);
      expect(getUpdateRun(initial.runId)).toMatchObject({
        status,
        origin: { nextAction: advice },
        steps: expect.arrayContaining([
          expect.objectContaining({ step: "warning:gateway-auth", detail: warning }),
        ]),
        verification: { port: 19123, versionMatch: false, noticeDelivered: true },
      });
    },
  );

  it.each([false, true])(
    "outlives the requesting attempt while honoring session replacement (%s)",
    async (replaced) => {
      const target = {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "update-session",
        storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
      };
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        lifecycleRevision: "admitted-session",
        updatedAt: 1,
      });
      const run = createUpdateRun({ trigger: "chat", origin: { sessionKey: target.sessionKey } });
      const notify = await createUpdateRunNotifier(run, () => ({}), {});
      if (replaced) {
        await upsertSessionEntryCore(target, {
          sessionId: target.sessionId,
          lifecycleRevision: "replacement-session",
          updatedAt: 2,
        });
      }
      const result = await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: target,
          withTranscriptWrite: async () => {
            throw new Error("attempt disposed before transcript write");
          },
        },
        () => notify(run, "parking"),
      );
      expect(result).toEqual({ delivered: !replaced, owned: !replaced });
      const events = await loadTranscriptEvents(target);
      const messages = events.filter((event) => asOptionalRecord(event)?.type === "message");
      expect(messages).toHaveLength(replaced ? 0 : 1);
      if (!replaced) {
        expect(messages[0]).toMatchObject({
          message: {
            role: "assistant",
            content: [{ type: "text", text: renderUpdateRunNotice(run, "parking") }],
          },
        });
        expect(getUpdateRun(run.runId)?.steps).toContainEqual(
          expect.objectContaining({ step: "notice:activating", status: "completed" }),
        );
      }
      expect(getUpdateRun(run.runId)?.phase).toBe("requested");
    },
  );

  it("reconciles a terminal notice admitted before an interrupted run was re-finished", async () => {
    const target = noticeTarget();
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const run = createUpdateRun({
      trigger: "cli",
      origin: {
        sessionKey: target.sessionKey,
        driver: { host: hostname(), pid: exitedPid(), startIdentity: "1" },
      },
      before: { version: "2026.9.1" },
      target: { kind: "package", tag: "/synthetic/candidate.tgz" },
    });
    recordUpdateRunStep(run.runId, {
      step: "finalize:installed-candidate",
      status: "completed",
      detail: JSON.stringify({ version: "2026.9.2", buildId: "candidate-build" }),
    });
    recordUpdateRunStep(run.runId, { step: "post-update verification", status: "completed" });
    recordUpdateRunPhase(run.runId, "restarting");
    recordUpdateRunPhase(run.runId, "verifying");
    const [failed] = reconcileUpdateRunsInNativeKernelForTest({}, { env: state.env });
    if (!failed) {
      throw new Error("Missing abandoned update");
    }
    expect(failed).toMatchObject({ status: "failed", reason: "abandoned" });
    expect(canSettleInterruptedUpdate(failed)).toBe(true);
    const failedText = renderUpdateRunNotice(failed, "finished");
    if (!failedText) {
      throw new Error("Missing failed terminal notice");
    }
    // The earlier completion path admitted its terminal text, but its receipt
    // write never followed. Interrupted-update settlement then corrects the run.
    expect(
      await appendAssistantMessageToSessionTranscript({
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        expectedSessionId: target.sessionId,
        storePath: target.storePath,
        text: failedText,
        idempotencyKey: `update-run-finished:${run.runId}`,
      }),
    ).toMatchObject({ ok: true });
    const settled = persistInterruptedUpdateObservation(
      {
        expected: failed,
        detail: "Installed and serving candidate verified.",
        verification: {
          booted: true,
          serviceRunning: true,
          versionMatch: true,
          readyz: true,
          channelsReady: true,
          pluginErrors: [],
        },
        cleanup: "confirmed",
      },
      { env: state.env },
      () => {},
    );
    expect(settled.accepted).toBe(true);
    const corrected = settled.run;
    if (!corrected) {
      throw new Error("Missing corrected update");
    }
    expect(corrected.status).toBe("succeeded");
    expect(corrected.verification.noticeDelivered).toBeUndefined();

    const notify = await createUpdateRunNotifier(corrected, () => ({}), {});
    expect(await notify(corrected, "finished")).toEqual({ delivered: true, owned: true });

    expect(getUpdateRun(run.runId)?.verification.noticeDelivered).toBe(true);
    const messages = (await loadTranscriptEvents(target)).filter(
      (event) => asOptionalRecord(event)?.type === "message",
    );
    // The already-admitted terminal notice is the run's one completion entry.
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      message: { role: "assistant", content: [{ type: "text", text: failedText }] },
    });
  });

  it("ignores a stale terminal snapshot after another completion path delivered", async () => {
    const target = noticeTarget();
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const run = createUpdateRun({ trigger: "chat", origin: { sessionKey: target.sessionKey } });
    const succeeded = finishUpdateRun(run.runId, { status: "succeeded" });
    if (!succeeded) {
      throw new Error("Missing finished update");
    }
    const notify = await createUpdateRunNotifier(run, () => ({}), {});
    expect(await notify(succeeded, "finished")).toEqual({ delivered: true, owned: true });
    const delivered = getUpdateRun(run.runId)!;
    expect(delivered.verification.noticeDelivered).toBe(true);

    // A notifier snapshot captured before interrupted-update settlement still
    // renders the failed outcome, but the transcript already owns the notice.
    const stale = {
      ...structuredClone(delivered),
      status: "failed" as const,
      reason: "abandoned",
      verification: {},
    };
    expect(renderUpdateRunNotice(stale, "finished")).not.toBe(
      renderUpdateRunNotice(delivered, "finished"),
    );
    expect(await notify(stale, "finished")).toEqual({ delivered: true, owned: true });

    const messages = (await loadTranscriptEvents(target)).filter(
      (event) => asOptionalRecord(event)?.type === "message",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      message: {
        role: "assistant",
        content: [{ type: "text", text: renderUpdateRunSummary(delivered) }],
      },
    });
  });

  it("fails closed when the admitted message is not a terminal update notice", async () => {
    const target = noticeTarget();
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const run = createUpdateRun({ trigger: "chat", origin: { sessionKey: target.sessionKey } });
    const finished = finishUpdateRun(run.runId, { status: "succeeded" });
    if (!finished) {
      throw new Error("Missing finished update");
    }
    const inProgressText = renderUpdateRunNotice(
      { status: "running", reason: null, phase: "verifying" },
      "verifying",
    );
    if (!inProgressText) {
      throw new Error("Missing in-progress notice");
    }
    expect(
      await appendAssistantMessageToSessionTranscript({
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        expectedSessionId: target.sessionId,
        storePath: target.storePath,
        text: inProgressText,
        idempotencyKey: `update-run-finished:${run.runId}`,
      }),
    ).toMatchObject({ ok: true });

    const notify = await createUpdateRunNotifier(run, () => ({}), {});
    // The terminal snapshot is what reaches the notifier; the non-terminal
    // admitted message under the same key must reject it, not skip rendering.
    expect(await notify(finished, "finished")).toEqual({ delivered: false, owned: false });
    expect(getUpdateRun(run.runId)?.verification.noticeDelivered).not.toBe(true);

    const messages = (await loadTranscriptEvents(target)).filter(
      (event) => asOptionalRecord(event)?.type === "message",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      message: { role: "assistant", content: [{ type: "text", text: inProgressText }] },
    });
  });

  function noticeTarget() {
    return {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "update-session",
      storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
    };
  }
});

/** A PID that cannot be the recorded driver identity; identity mismatch reads as dead. */
function exitedPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  if (typeof child.pid !== "number") {
    throw new Error("Missing exited child pid");
  }
  return child.pid;
}
