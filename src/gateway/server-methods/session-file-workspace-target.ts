import path from "node:path";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { sessionFilesError } from "./session-files-errors.js";
import type { RespondFn } from "./types.js";

export type SessionFileWorkspaceTarget = {
  /**
   * Managed-worktree identity for the CAS token. It binds the worktree id and
   * root because either can survive a reset that changes the other.
   */
  hashScope: string | undefined;
  /** Opaque target identity that read callers echo on save. */
  workspaceId: string | undefined;
};

/**
 * Resolves the exact session workspace target a file token belongs to.
 *
 * Relative file paths resolve against `fileRoot`, which can change while the
 * managed workspace root and worktree id survive a cwd-only reset. Bind every
 * directory that selects the file so that reset cannot retarget a draft.
 */
export function resolveFileWorkspaceTarget(
  worktreeId: string | undefined,
  root: string | undefined,
  fileRoot: string | undefined,
): SessionFileWorkspaceTarget {
  // Normalize both directories so an equivalent spelling of the same path keeps
  // the same target instead of stranding a draft across a reset.
  const resolvedRoot = root ? path.resolve(root) : undefined;
  const resolvedFileRoot = fileRoot ? path.resolve(fileRoot) : undefined;
  const directories =
    resolvedRoot && resolvedFileRoot && resolvedFileRoot !== resolvedRoot
      ? `${resolvedRoot}\0${resolvedFileRoot}`
      : resolvedRoot;
  const hashScope = worktreeId && directories ? `${worktreeId}\0${directories}` : undefined;
  const target = hashScope ?? directories;
  return { hashScope, workspaceId: target ? sha256Hex(target) : undefined };
}

/**
 * Refuses a save whose draft belonged to a workspace target that was replaced.
 * A content hash cannot tell an in-place edit from a replacement workspace
 * holding identical bytes, so the read-time target is checked before any write.
 */
export function refuseFileWorkspaceChange(
  respond: RespondFn,
  path: string,
  requested: string | undefined,
  current: string | undefined,
): boolean {
  if (requested === undefined || requested === current) {
    return false;
  }
  respond(
    false,
    undefined,
    sessionFilesError("session_file_conflict", "session workspace changed since it was read", {
      path,
      reason: "workspace_changed",
    }),
  );
  return true;
}
