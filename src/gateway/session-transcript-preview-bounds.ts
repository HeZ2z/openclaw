import type { SessionPreviewItem } from "./session-utils.types.js";

/** Hard ceilings for one preview tail read; callers never page past these. */
export const SESSION_PREVIEW_SCAN_MAX_EVENTS = 2048;
export const SESSION_PREVIEW_SCAN_MAX_BYTES = 8 * 1024 * 1024;

export type SessionPreviewReadWindow = {
  maxEvents: number;
  maxBytes: number;
};

export type SessionPreviewPage = {
  items: SessionPreviewItem[];
  hasOlderEvents: boolean;
};

/**
 * Tail windows widen only after a smaller page cannot satisfy the requested items.
 * The final window is the explicit scan ceiling, so a tool-only or suppressed tail
 * longer than the ordinary recovery page can still recover without a full read.
 */
export function sessionPreviewReadWindows(maxItems: number): readonly SessionPreviewReadWindow[] {
  const requestedItems = Math.max(1, Math.ceil(maxItems));
  const initialMaxEvents = Math.min(256, Math.max(64, requestedItems * 4));
  const recoveryMaxEvents = Math.min(
    SESSION_PREVIEW_SCAN_MAX_EVENTS,
    Math.max(1024, initialMaxEvents * 8, requestedItems),
  );
  const windows: SessionPreviewReadWindow[] = [
    { maxEvents: initialMaxEvents, maxBytes: 1024 * 1024 },
  ];
  if (recoveryMaxEvents > initialMaxEvents) {
    windows.push({ maxEvents: recoveryMaxEvents, maxBytes: SESSION_PREVIEW_SCAN_MAX_BYTES });
  }
  if (recoveryMaxEvents < SESSION_PREVIEW_SCAN_MAX_EVENTS) {
    windows.push({
      maxEvents: SESSION_PREVIEW_SCAN_MAX_EVENTS,
      maxBytes: SESSION_PREVIEW_SCAN_MAX_BYTES,
    });
  }
  return windows;
}

/** Synchronous display and in-memory readers share the same bounded widening policy. */
export function readBoundedSessionPreviewItems(
  maxItems: number,
  readPage: (window: SessionPreviewReadWindow) => SessionPreviewPage,
): SessionPreviewItem[] {
  let items: SessionPreviewItem[] = [];
  for (const window of sessionPreviewReadWindows(maxItems)) {
    const page = readPage(window);
    items = page.items;
    if (items.length >= maxItems || !page.hasOlderEvents) {
      break;
    }
  }
  return items;
}

/** Talk's model-context reader shares the same bounded widening policy as display previews. */
export async function readBoundedSessionPreviewItemsAsync(
  maxItems: number,
  readPage: (window: SessionPreviewReadWindow) => Promise<SessionPreviewPage>,
): Promise<SessionPreviewItem[]> {
  let items: SessionPreviewItem[] = [];
  for (const window of sessionPreviewReadWindows(maxItems)) {
    const page = await readPage(window);
    items = page.items;
    if (items.length >= maxItems || !page.hasOlderEvents) {
      break;
    }
  }
  return items;
}
