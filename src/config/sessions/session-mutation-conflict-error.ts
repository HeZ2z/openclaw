import {
  collectErrorGraphCandidates,
  readErrorCauses,
} from "@openclaw/normalization-core/error-coercion";

export class SqliteSessionMutationConflictError extends Error {
  constructor(readonly operationLabel: string) {
    super(`SQLite session state changed while preparing ${operationLabel}`);
    this.name = "SqliteSessionMutationConflictError";
  }
}

export class SqliteTranscriptMutationConflictError extends Error {
  constructor(readonly sessionId: string) {
    super(`SQLite transcript changed while preparing rewrite for ${sessionId}`);
    this.name = "SqliteTranscriptMutationConflictError";
  }
}

export function isSqliteTranscriptMutationConflict(error: unknown): boolean {
  return collectErrorGraphCandidates(error, readErrorCauses).some(
    (candidate) => candidate instanceof SqliteTranscriptMutationConflictError,
  );
}

export class SessionEntryLifecycleUpsertConflictError extends Error {
  constructor(readonly sessionKey: string) {
    super(`SQLite session entry changed before lifecycle upsert for ${sessionKey}`);
    this.name = "SessionEntryLifecycleUpsertConflictError";
  }
}

/** A scoped idempotency key already owns different transcript content. */
export class TranscriptIdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`Transcript idempotency key "${idempotencyKey}" conflicts with the admitted message.`);
    this.name = "TranscriptIdempotencyConflictError";
  }
}

/** Producers that own an idempotency key may reconcile their own admitted message. */
export function isTranscriptIdempotencyConflict(error: unknown, idempotencyKey?: string): boolean {
  return collectErrorGraphCandidates(error, readErrorCauses).some(
    (candidate) =>
      candidate instanceof TranscriptIdempotencyConflictError &&
      (idempotencyKey === undefined || candidate.idempotencyKey === idempotencyKey),
  );
}
