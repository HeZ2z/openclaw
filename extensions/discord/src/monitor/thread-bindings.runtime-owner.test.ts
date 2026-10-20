import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import { createThreadBindingManager } from "./thread-bindings.manager.js";
import { resetThreadBindingsForTests } from "./thread-bindings.test-support.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

const rows = new Map<string, ThreadBindingRecord>();
const stores = vi.hoisted(() => ({
  entries: vi.fn(),
  register: vi.fn(),
  delete: vi.fn(),
  openKeyedStoreV2: vi.fn(),
  openSyncKeyedStore: vi.fn(),
}));
const ambient = vi.hoisted(() => ({ available: true }));

const runtime = {
  state: {
    openKeyedStoreV2: stores.openKeyedStoreV2,
    openSyncKeyedStore: stores.openSyncKeyedStore,
  },
};

// The manager is created while Discord's runtime is ambient, then the adapter
// write arrives from another plugin instance's slot.
// mock-isolation: the runtime slot and its stores are the state under test.
vi.mock("../runtime.js", () => ({
  getOptionalDiscordRuntime: () => runtime,
  getDiscordRuntime: () => {
    if (!ambient.available) {
      throw new Error("Discord runtime not initialized");
    }
    return runtime;
  },
}));

beforeEach(async () => {
  await resetThreadBindingsForTests();
  rows.clear();
  ambient.available = true;
  for (const mock of Object.values(stores)) {
    mock.mockReset();
  }
  stores.entries.mockImplementation(async () =>
    [...rows].map(([key, value]) => ({ key, value, createdAt: 1 })),
  );
  stores.register.mockImplementation(async (key: string, value: ThreadBindingRecord) => {
    rows.set(key, value);
  });
  stores.delete.mockImplementation(async (key: string) => rows.delete(key));
  stores.openKeyedStoreV2.mockImplementation((options: OpenKeyedStoreOptions) => {
    void options;
    return { entries: stores.entries, register: stores.register, delete: stores.delete };
  });
  stores.openSyncKeyedStore.mockImplementation((options: OpenKeyedStoreOptions) => {
    void options;
    return { entries: stores.entries, register: stores.register, delete: stores.delete };
  });
});

afterEach(resetThreadBindingsForTests);

it("persists a manager write after the ambient runtime slot is gone", async () => {
  const manager = await createThreadBindingManager({
    cfg: EMPTY_DISCORD_TEST_CONFIG,
    accountId: "default",
    persist: true,
    enableSweeper: false,
  });

  ambient.available = false;
  const record = await manager.bindTarget({
    threadId: "user:123",
    channelId: "user:123",
    targetKind: "acp",
    targetSessionKey: "agent:codex:acp:binding",
    agentId: "codex",
  });

  expect(record).toMatchObject({ targetSessionKey: "agent:codex:acp:binding" });
  expect(rows.get("default:user:123")).toMatchObject({
    targetSessionKey: "agent:codex:acp:binding",
  });
});
