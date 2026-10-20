import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { readRetainedSessionEntryFacts } from "../../config/sessions/session-entry-read-facts.js";
import { readSessionEntriesFromStoreInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import { createSessionFileDownloadClient } from "./sessions-files.test-support.js";
import type { GatewayClient } from "./types.js";

const hooks = vi.hoisted(() => ({
  duringSettlement: undefined as (() => Promise<void>) | undefined,
}));

// Real settlement; the hook changes session state or cache residency while it is in progress.
vi.mock("../worker-environments/local-workspace-projection.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../worker-environments/local-workspace-projection.js")>();
  return {
    ...actual,
    withSettledLocalWorkspacePath: (async (params, operation) => {
      await hooks.duringSettlement?.();
      return await actual.withSettledLocalWorkspacePath(params, operation);
    }) satisfies typeof actual.withSettledLocalWorkspacePath,
  };
});

const key = "agent:main:worktree-files";

async function dispatch(
  method:
    | "sessions.files.list"
    | "sessions.files.get"
    | "sessions.files.download"
    | "sessions.files.set",
  filePath?: string,
  client: GatewayClient | null = null,
  extraParams: Record<string, unknown> = {},
) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: method,
      method,
      params: {
        sessionKey: key,
        agentId: "main",
        ...(filePath ? { path: filePath } : {}),
        ...extraParams,
      },
    },
    client,
    context: createDirectChatContext({ getRuntimeConfig: () => ({}) }),
    respond,
    isWebchatConnect: () => false,
    extraHandlers: sessionsFilesHandlers,
  });
  return respond;
}

async function seedWorktreeSession(workspaceDir: string) {
  setRuntimeConfigSnapshot({});
  const worktreeDir = path.join(workspaceDir, "worktree");
  fs.mkdirSync(worktreeDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeDir, "preview.html"), "<h1>boo</h1>\n");
  const entry = {
    sessionId: "worktree-session",
    lifecycleRevision: "rev-1",
    updatedAt: 1,
    spawnedCwd: worktreeDir,
    worktree: { id: "wt-1", branch: "openclaw/test", repoRoot: workspaceDir },
  };
  await sessions.upsertSessionEntryCore({ agentId: "main", sessionKey: key }, entry);
  return entry;
}

function seedReplicaPressure(env: NodeJS.ProcessEnv) {
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const siblingKeys = Array.from(
    { length: 128 },
    (_, index) => `agent:main:file-reader-pressure-${index}`,
  );
  runOpenClawAgentWriteTransaction(
    (writer) => {
      for (const sessionKey of siblingKeys) {
        writeSessionEntry(writer, sessionKey, { sessionId: sessionKey, updatedAt: 1 });
      }
    },
    { agentId: "main", path: database.path, env },
  );
  const read = (sessionKeys: string[]) =>
    readSessionEntriesFromStoreInWorker({
      agentId: "main",
      storePath: database.path,
      env,
      sessionKeys,
    });
  const retained = () =>
    readRetainedSessionEntryFacts(
      { agentId: "main", path: database.path },
      { sessionKeys: [key], projection: "exact", snapshotFields: ["skillsSnapshot"] },
    );
  return async () => {
    await read([key]);
    expect(retained()?.entries[0]?.entry.sessionId).toBe("worktree-session");
    await read(siblingKeys.slice(0, 64));
    await read(siblingKeys.slice(64));
    expect(retained()).toBeUndefined();
  };
}

describe("sessions.files for managed-worktree sessions", () => {
  it("reads files from a durable session's worktree", async () => {
    hooks.duringSettlement = undefined;
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await seedWorktreeSession(state.workspaceDir);

      const list = await dispatch("sessions.files.list");
      expect(list).toHaveBeenCalledOnce();
      expect(list.mock.calls[0]?.[2]).toBeUndefined();
      expect(list.mock.calls[0]?.[0]).toBe(true);

      const get = await dispatch("sessions.files.get", "preview.html");
      expect(get).toHaveBeenCalledOnce();
      expect(get.mock.calls[0]?.[2]).toBeUndefined();
      expect(get.mock.calls[0]?.[1]).toMatchObject({ file: { content: "<h1>boo</h1>\n" } });
    });
  });

  it("keeps a durable file preview readable after its cached session row is evicted", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const evict = seedReplicaPressure(state.env);
      await seedWorktreeSession(state.workspaceDir);
      hooks.duringSettlement = async () => {
        hooks.duringSettlement = undefined;
        await evict();
      };
      try {
        const response = await dispatch("sessions.files.get", "preview.html");
        expect(hooks.duringSettlement).toBeUndefined();
        expect(response).toHaveBeenCalledOnce();
        expect(response.mock.calls[0]?.[2]).toBeUndefined();
        expect(response.mock.calls[0]?.[0]).toBe(true);
        expect(response.mock.calls[0]?.[1]).toMatchObject({
          file: { content: "<h1>boo</h1>\n" },
        });
      } finally {
        hooks.duringSettlement = undefined;
      }
    });
  });

  it("keeps a download grant through cache eviction and revokes it after a workspace change", async () => {
    hooks.duringSettlement = undefined;
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const evict = seedReplicaPressure(state.env);
      const entry = await seedWorktreeSession(state.workspaceDir);
      using connection = createSessionFileDownloadClient();
      const response = await dispatch("sessions.files.download", "preview.html", connection.client);
      expect(response).toHaveBeenCalledOnce();
      expect(response.mock.calls[0]?.[2]).toBeUndefined();
      expect(response.mock.calls[0]?.[0]).toBe(true);
      const url = response.mock.calls[0]?.[1]?.url;
      expect(url).toEqual(expect.any(String));

      await evict();
      const downloaded = await connection.fetch(url);
      expect(downloaded.response.statusCode).toBe(200);
      expect(Buffer.from(downloaded.body ?? []).toString()).toBe("<h1>boo</h1>\n");

      await sessions.upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        { ...entry, updatedAt: 2, worktree: { ...entry.worktree, id: "wt-2" } },
      );
      expect((await connection.fetch(url)).response.statusCode).toBe(404);
    });
  });

  it("refuses the read when the session moves to another worktree during settlement", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const entry = await seedWorktreeSession(state.workspaceDir);
      hooks.duringSettlement = async () => {
        hooks.duringSettlement = undefined;
        await sessions.upsertSessionEntryCore(
          { agentId: "main", sessionKey: key },
          { ...entry, updatedAt: 2, worktree: { ...entry.worktree, id: "wt-2" } },
        );
      };
      try {
        const response = await dispatch("sessions.files.get", "preview.html");
        expect(hooks.duringSettlement).toBeUndefined();
        expect(response).toHaveBeenCalledOnce();
        expect(response.mock.calls[0]?.[0]).toBe(false);
        expect(response.mock.calls[0]?.[2]).toMatchObject({
          message: "Session workspace changed during file access",
        });
      } finally {
        hooks.duringSettlement = undefined;
      }
    });
  });

  it("refuses a stale save after the same chat replaces its worktree", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const entry = await seedWorktreeSession(state.workspaceDir);
      const firstDir = path.join(state.workspaceDir, "worktree");
      fs.writeFileSync(path.join(firstDir, "README.md"), "base\n");
      const first = await dispatch("sessions.files.get", "README.md");
      expect(first.mock.calls[0]?.[0]).toBe(true);
      const staleHash = first.mock.calls[0]?.[1]?.file?.hash;
      expect(staleHash).toEqual(expect.any(String));

      // Same chat key, replacement managed worktree, byte-identical file.
      const replacementDir = path.join(state.workspaceDir, "replacement");
      fs.mkdirSync(replacementDir);
      fs.writeFileSync(path.join(replacementDir, "README.md"), "base\n");
      await sessions.upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        {
          ...entry,
          updatedAt: 2,
          spawnedCwd: replacementDir,
          worktree: { ...entry.worktree, id: "wt-2" },
        },
      );
      sessionChanges.emit({ sessionKey: key });

      const draft = "draft from the original workspace\n";
      const rejected = await dispatch("sessions.files.set", "README.md", null, {
        content: draft,
        expectedHash: staleHash,
      });
      expect(rejected.mock.calls[0]?.[0]).toBe(false);
      expect(rejected.mock.calls[0]?.[2]).toMatchObject({
        details: { type: "session_file_conflict" },
      });
      expect(fs.readFileSync(path.join(replacementDir, "README.md"), "utf8")).toBe("base\n");

      const fresh = await dispatch("sessions.files.get", "README.md");
      expect(fresh.mock.calls[0]?.[0]).toBe(true);
      const freshHash = fresh.mock.calls[0]?.[1]?.file?.hash;
      expect(freshHash).not.toBe(staleHash);

      const saved = await dispatch("sessions.files.set", "README.md", null, {
        content: draft,
        expectedHash: freshHash,
      });
      expect(saved.mock.calls[0]?.[0]).toBe(true);
      expect(fs.readFileSync(path.join(replacementDir, "README.md"), "utf8")).toBe(draft);
    });
  });

  it("refuses the editor's overwrite recovery after the same chat replaces its worktree", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const entry = await seedWorktreeSession(state.workspaceDir);
      const firstDir = path.join(state.workspaceDir, "worktree");
      fs.writeFileSync(path.join(firstDir, "README.md"), "base\n");
      const first = await dispatch("sessions.files.get", "README.md");
      expect(first.mock.calls[0]?.[0]).toBe(true);
      const firstHash = first.mock.calls[0]?.[1]?.file?.hash;
      const firstWorkspaceId = first.mock.calls[0]?.[1]?.workspaceId;
      expect(firstHash).toEqual(expect.any(String));
      expect(firstWorkspaceId).toEqual(expect.any(String));

      // A same-workspace content conflict keeps ordinary Reload/Overwrite recovery.
      fs.writeFileSync(path.join(firstDir, "README.md"), "agent edit\n");
      const contentConflict = await dispatch("sessions.files.set", "README.md", null, {
        content: "local draft\n",
        expectedHash: firstHash,
        workspaceId: firstWorkspaceId,
      });
      expect(contentConflict.mock.calls[0]?.[0]).toBe(false);
      expect(contentConflict.mock.calls[0]?.[2]).toMatchObject({
        details: { type: "session_file_conflict", path: "README.md" },
      });
      expect(contentConflict.mock.calls[0]?.[2]?.details?.reason).toBeUndefined();

      const sameTarget = await dispatch("sessions.files.get", "README.md");
      expect(sameTarget.mock.calls[0]?.[1]?.workspaceId).toBe(firstWorkspaceId);
      const overwritten = await dispatch("sessions.files.set", "README.md", null, {
        content: "local draft\n",
        expectedHash: sameTarget.mock.calls[0]?.[1]?.file?.hash,
        workspaceId: firstWorkspaceId,
      });
      expect(overwritten.mock.calls[0]?.[0]).toBe(true);
      expect(fs.readFileSync(path.join(firstDir, "README.md"), "utf8")).toBe("local draft\n");

      // Same chat key, replacement managed worktree, byte-identical file. The
      // editor's Overwrite recovery submits the fresh hash plus the old draft's
      // workspace identity; the stale target must still be refused.
      const replacementDir = path.join(state.workspaceDir, "replacement");
      fs.mkdirSync(replacementDir);
      fs.writeFileSync(path.join(replacementDir, "README.md"), "base\n");
      await sessions.upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        {
          ...entry,
          updatedAt: 3,
          spawnedCwd: replacementDir,
          worktree: { ...entry.worktree, id: "wt-2" },
        },
      );
      sessionChanges.emit({ sessionKey: key });

      const fetched = await dispatch("sessions.files.get", "README.md");
      expect(fetched.mock.calls[0]?.[0]).toBe(true);
      const fetchedHash = fetched.mock.calls[0]?.[1]?.file?.hash;
      const fetchedWorkspaceId = fetched.mock.calls[0]?.[1]?.workspaceId;
      expect(fetchedHash).toEqual(expect.any(String));
      expect(fetchedWorkspaceId).toEqual(expect.any(String));
      expect(fetchedWorkspaceId).not.toBe(firstWorkspaceId);

      const overwriteRecovery = await dispatch("sessions.files.set", "README.md", null, {
        content: "local draft\n",
        expectedHash: fetchedHash,
        workspaceId: firstWorkspaceId,
      });
      expect(overwriteRecovery.mock.calls[0]?.[0]).toBe(false);
      expect(overwriteRecovery.mock.calls[0]?.[2]).toMatchObject({
        details: {
          type: "session_file_conflict",
          reason: "workspace_changed",
          path: "README.md",
        },
      });
      expect(fs.readFileSync(path.join(replacementDir, "README.md"), "utf8")).toBe("base\n");

      // Reopening the replacement file adopts its target and saves normally.
      const fresh = await dispatch("sessions.files.get", "README.md");
      const freshHash = fresh.mock.calls[0]?.[1]?.file?.hash;
      const freshWorkspaceId = fresh.mock.calls[0]?.[1]?.workspaceId;
      expect(freshWorkspaceId).toBe(fetchedWorkspaceId);
      const saved = await dispatch("sessions.files.set", "README.md", null, {
        content: "reopened draft saved\n",
        expectedHash: freshHash,
        workspaceId: freshWorkspaceId,
      });
      expect(saved.mock.calls[0]?.[0]).toBe(true);
      expect(fs.readFileSync(path.join(replacementDir, "README.md"), "utf8")).toBe(
        "reopened draft saved\n",
      );
    });
  });

  it("refuses an ordinary session's stale draft after its root changes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const firstDir = path.join(state.workspaceDir, "first");
      fs.mkdirSync(firstDir, { recursive: true });
      fs.writeFileSync(path.join(firstDir, "README.md"), "base\n");
      await sessions.upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        {
          sessionId: "ordinary-session",
          lifecycleRevision: "rev-1",
          updatedAt: 1,
          spawnedCwd: firstDir,
        },
      );
      const first = await dispatch("sessions.files.get", "README.md");
      expect(first.mock.calls[0]?.[0]).toBe(true);
      const staleHash = first.mock.calls[0]?.[1]?.file?.hash;
      const staleWorkspaceId = first.mock.calls[0]?.[1]?.workspaceId;
      expect(staleHash).toEqual(expect.any(String));
      expect(staleWorkspaceId).toEqual(expect.any(String));

      // The new root holds byte-identical content, so the plain hash still matches.
      const replacementDir = path.join(state.workspaceDir, "replacement");
      fs.mkdirSync(replacementDir);
      fs.writeFileSync(path.join(replacementDir, "README.md"), "base\n");
      await sessions.upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        {
          sessionId: "ordinary-session",
          lifecycleRevision: "rev-2",
          updatedAt: 2,
          spawnedCwd: replacementDir,
        },
      );
      sessionChanges.emit({ sessionKey: key });
      const fresh = await dispatch("sessions.files.get", "README.md");
      expect(fresh.mock.calls[0]?.[0]).toBe(true);
      expect(fresh.mock.calls[0]?.[1]?.file?.hash).toBe(staleHash);
      expect(fresh.mock.calls[0]?.[1]?.workspaceId).not.toBe(staleWorkspaceId);

      const refused = await dispatch("sessions.files.set", "README.md", null, {
        content: "draft from the original root\n",
        expectedHash: fresh.mock.calls[0]?.[1]?.file?.hash,
        workspaceId: staleWorkspaceId,
      });
      expect(refused.mock.calls[0]?.[0]).toBe(false);
      expect(refused.mock.calls[0]?.[2]).toMatchObject({
        details: { type: "session_file_conflict", reason: "workspace_changed" },
      });
      expect(fs.readFileSync(path.join(replacementDir, "README.md"), "utf8")).toBe("base\n");
    });
  });

  it("refuses a stale save when the same worktree id points at a new root", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const entry = await seedWorktreeSession(state.workspaceDir);
      const firstDir = path.join(state.workspaceDir, "worktree");
      fs.writeFileSync(path.join(firstDir, "README.md"), "base\n");
      const first = await dispatch("sessions.files.get", "README.md");
      expect(first.mock.calls[0]?.[0]).toBe(true);
      const staleHash = first.mock.calls[0]?.[1]?.file?.hash;
      expect(staleHash).toEqual(expect.any(String));

      // The worktree id survives a create-with-cwd reset while the root changes.
      const replacementDir = path.join(state.workspaceDir, "replacement");
      fs.mkdirSync(replacementDir);
      fs.writeFileSync(path.join(replacementDir, "README.md"), "base\n");
      await sessions.upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        { ...entry, updatedAt: 2, spawnedCwd: replacementDir },
      );
      sessionChanges.emit({ sessionKey: key });

      const rejected = await dispatch("sessions.files.set", "README.md", null, {
        content: "draft from the original root\n",
        expectedHash: staleHash,
      });
      expect(rejected.mock.calls[0]?.[0]).toBe(false);
      expect(rejected.mock.calls[0]?.[2]).toMatchObject({
        details: { type: "session_file_conflict" },
      });
      expect(fs.readFileSync(path.join(replacementDir, "README.md"), "utf8")).toBe("base\n");

      const freshHash = (await dispatch("sessions.files.get", "README.md")).mock.calls[0]?.[1]?.file
        ?.hash;
      expect(freshHash).not.toBe(staleHash);
    });
  });
});
