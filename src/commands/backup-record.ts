import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { recordBackupOutcomeBestEffort } from "./backup-shared.js";

export type BackupRecordOptions = {
  status?: string;
  target?: string;
  bytes?: string | number;
  error?: string;
  json?: boolean;
};

// Number() also accepts hex, octal, binary, exponent, signed, and whitespace-padded
// forms; only canonical decimal integers are valid byte counts.
function parseBackupBytes(value: string | number | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Host-owned jobs can contribute outcomes without changing their execution owner. */
export async function backupRecordCommand(
  runtime: RuntimeEnv,
  opts: BackupRecordOptions,
): Promise<void> {
  if (opts.status !== "ok" && opts.status !== "failed") {
    throw new Error("--status must be ok or failed.");
  }
  const target = opts.target?.trim();
  if (!target) {
    throw new Error("Missing required --target label.");
  }
  const bytes = parseBackupBytes(opts.bytes);
  if (opts.bytes !== undefined && bytes === undefined) {
    throw new Error("--bytes must be a nonnegative integer.");
  }
  const outcome = {
    kind: "external" as const,
    archivePath: target,
    target,
    status: opts.status,
    ...(bytes !== undefined ? { bytes } : {}),
    ...(opts.error ? { error: opts.error } : {}),
  };
  await recordBackupOutcomeBestEffort(runtime, outcome);
  if (opts.json) {
    writeRuntimeJson(runtime, outcome);
  } else {
    runtime.log(`External backup: ${target} (${opts.status})`);
  }
}
