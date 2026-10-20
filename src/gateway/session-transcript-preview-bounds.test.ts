import { expect, test } from "vitest";
import {
  readBoundedSessionPreviewItems,
  readBoundedSessionPreviewItemsAsync,
  type SessionPreviewPage,
} from "./session-transcript-preview-bounds.js";

const previewItem = { role: "assistant" as const, text: "visible" };

function page(overrides: Partial<SessionPreviewPage>): SessionPreviewPage {
  return { items: [], hasOlderEvents: true, scannedEvents: 0, ...overrides };
}

test("event-capped pages keep widening until the scan ceiling", () => {
  const limits: number[] = [];
  const items = readBoundedSessionPreviewItems(12, (window) => {
    limits.push(window.maxEvents);
    return page({ scannedEvents: window.maxEvents });
  });
  expect(limits).toEqual([64, 1024, 2048]);
  expect(items).toEqual([]);
});

test("byte-capped initial page widens once to the larger byte budget", () => {
  const limits: number[] = [];
  readBoundedSessionPreviewItems(12, (window) => {
    limits.push(window.maxEvents);
    // The 1 MiB page is byte-capped; the 8 MiB recovery page then reaches the tail start.
    return window.maxEvents === 64
      ? page({ scannedEvents: 1 })
      : page({ hasOlderEvents: false, items: [previewItem], scannedEvents: 500 });
  });
  expect(limits).toEqual([64, 1024]);
});

test("byte-capped recovery page skips the duplicate ceiling-wide read", () => {
  const limits: number[] = [];
  readBoundedSessionPreviewItems(12, (window) => {
    limits.push(window.maxEvents);
    // Both widening pages share the 8 MiB budget, so a byte-capped recovery cannot advance.
    return page({ scannedEvents: window.maxEvents === 1024 ? 500 : window.maxEvents });
  });
  expect(limits).toEqual([64, 1024]);
});

test("async model-context widening skips the same byte-capped duplicate read", async () => {
  const limits: number[] = [];
  const items = await readBoundedSessionPreviewItemsAsync(12, async (window) => {
    limits.push(window.maxEvents);
    return page({ scannedEvents: window.maxEvents === 1024 ? 500 : window.maxEvents });
  });
  expect(limits).toEqual([64, 1024]);
  expect(items).toEqual([]);
});

test("a readable page below the item budget stops widening", () => {
  const limits: number[] = [];
  const items = readBoundedSessionPreviewItems(12, (window) => {
    limits.push(window.maxEvents);
    return page({ hasOlderEvents: false, items: [previewItem], scannedEvents: 3 });
  });
  expect(limits).toEqual([64]);
  expect(items).toEqual([previewItem]);
});
