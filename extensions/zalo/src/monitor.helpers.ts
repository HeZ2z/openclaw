// Small value, formatting, and logging helpers shared by Zalo monitor paths.
import type { ZaloRuntimeEnv } from "./monitor.types.js";
import { getZaloRuntime } from "./runtime.js";

const UNIX_MILLISECONDS_THRESHOLD = 1_000_000_000_000;

export type ZaloCoreRuntime = ReturnType<typeof getZaloRuntime>;

export function logZaloVerbose(
  core: ZaloCoreRuntime,
  runtime: ZaloRuntimeEnv,
  message: string,
): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[zalo] ${message}`);
  }
}

export function resolveZaloTimestampMs(date: number | undefined): number | undefined {
  if (!date) {
    return undefined;
  }
  return date >= UNIX_MILLISECONDS_THRESHOLD ? date : date * 1000;
}

export function formatZaloError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

export function describeWebhookTarget(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return rawUrl;
  }
}
