import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { isTranscriptIdempotencyConflict } from "../config/sessions/session-mutation-conflict-error.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  isUpdateRunTerminalNoticeText,
  renderUpdateRunNotice,
} from "../infra/update-run-notice.js";
import { getUpdateRunAsync } from "../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { recordUpdateRunVerificationAsync } from "../infra/update-run-write.async.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";

/** The one per-run key for the durable completion notice. */
function updateRunFinishedNoticeKey(runId: string): string {
  return `update-run-finished:${runId}`;
}

type FinishedNoticeSession = {
  agentId: string;
  sessionKey: string;
};

export type UpdateRunFinishedNoticeResult = {
  delivered: boolean;
  /** A newer snapshot withdrew the terminal outcome; the next poll owns it. */
  skipped?: boolean;
  reason?: string;
};

/**
 * Sole owner of the internal-session completion notice.
 *
 * Both completion paths (the update watcher notifier and restart-sentinel
 * recovery) delegate here so one transient snapshot can never own the wording.
 * The ledger is re-read immediately before rendering, and an admitted notice is
 * reconciled only against this run's terminal renderer output; any other
 * transcript conflict still fails closed.
 */
export async function deliverUpdateRunFinishedNotice(
  params: FinishedNoticeSession & {
    runId: string;
    expectedSessionId: string;
    expectedLifecycleRevision?: string | null;
    storePath: string;
    env?: NodeJS.ProcessEnv;
    /** Captured terminal wording, used only when the ledger cannot be read. */
    fallbackMessage?: string;
  },
): Promise<UpdateRunFinishedNoticeResult> {
  const options = params.env ? { env: params.env } : {};
  let run: UpdateRunRecord | undefined;
  let historyError: string | undefined;
  try {
    run = await getUpdateRunAsync(params.runId, options);
  } catch (error) {
    historyError = formatErrorMessage(error);
  }
  if (run?.verification.noticeDelivered === true) {
    return { delivered: true };
  }
  // A transient ledger read failure keeps the caller's terminal wording; the
  // transcript conflict path below still reconciles a differing admitted notice.
  const message = run ? renderUpdateRunNotice(run, "finished") : params.fallbackMessage;
  if (!message) {
    if (historyError) {
      return { delivered: false, reason: `update history unavailable: ${historyError}` };
    }
    if (!run) {
      return { delivered: false, reason: `update history missing for run ${params.runId}` };
    }
    // The snapshot that scheduled this delivery is no longer terminal.
    return { delivered: false, skipped: true };
  }
  const idempotencyKey = updateRunFinishedNoticeKey(params.runId);
  try {
    const appended = await appendAssistantMessageToSessionTranscript({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      expectedSessionId: params.expectedSessionId,
      expectedLifecycleRevision: params.expectedLifecycleRevision ?? null,
      storePath: params.storePath,
      text: message,
      idempotencyKey,
    });
    if (!appended.ok) {
      return { delivered: false, reason: appended.reason };
    }
  } catch (error) {
    if (!isTranscriptIdempotencyConflict(error, idempotencyKey)) {
      return { delivered: false, reason: formatErrorMessage(error) };
    }
    // A crash between the earlier append and its receipt leaves the run's one
    // admitted completion notice behind. Accept only the terminal renderer's
    // output; a foreign payload under this key stays a real conflict.
    if (!(await hasAdmittedTerminalNotice(params, idempotencyKey))) {
      return { delivered: false, reason: formatErrorMessage(error) };
    }
  }
  try {
    await recordUpdateRunVerificationAsync(params.runId, { noticeDelivered: true }, options);
  } catch (error) {
    return { delivered: false, reason: formatErrorMessage(error) };
  }
  return { delivered: true };
}

async function hasAdmittedTerminalNotice(
  params: FinishedNoticeSession & {
    expectedSessionId: string;
    storePath: string;
    env?: NodeJS.ProcessEnv;
  },
  idempotencyKey: string,
): Promise<boolean> {
  let events: Awaited<ReturnType<typeof loadTranscriptEvents>>;
  try {
    events = await loadTranscriptEvents({
      agentId: params.agentId,
      sessionId: params.expectedSessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      ...(params.env ? { env: params.env } : {}),
    });
  } catch {
    // The admitted bytes are unverifiable; keep the conflict instead of guessing.
    return false;
  }
  return events.some((event) => {
    const entry = asOptionalRecord(event);
    if (entry?.type !== "message") {
      return false;
    }
    const message = asOptionalRecord(entry.message);
    if (message?.role !== "assistant" || message.idempotencyKey !== idempotencyKey) {
      return false;
    }
    const text = extractFirstTextBlock(message);
    return text !== undefined && isUpdateRunTerminalNoticeText(text);
  });
}
