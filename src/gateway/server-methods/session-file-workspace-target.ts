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

/** Resolves the exact session workspace target a file token belongs to. */
export function resolveFileWorkspaceTarget(
  worktreeId: string | undefined,
  root: string | undefined,
): SessionFileWorkspaceTarget {
  const hashScope = worktreeId && root ? `${worktreeId}\0${root}` : undefined;
  const target = hashScope ?? root;
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
