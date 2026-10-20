import {
  captureFileEditorDraft,
  type RetainedFileDraft,
  setFileDraft,
} from "./chat-file-drafts.ts";
import type { FileSidebarContent } from "./chat-sidebar-content-types.ts";

export type FileSaveNotice =
  | { kind: "conflict" }
  | { kind: "workspace-changed" }
  | { kind: "error"; message: string };

/** Draft/save state for one open file editor tab. */
export type FileEditState = {
  savedContent: string;
  draftContent: string | null;
  /** CAS token for the saved content, which may belong to a replaced workspace. */
  hash: string;
  /** Workspace target the draft content was read from, not necessarily the tab's. */
  workspaceId: string | undefined;
  dirty: boolean;
  notice: FileSaveNotice | null;
};

export function createFileEditState(): FileEditState {
  return {
    savedContent: "",
    draftContent: null,
    hash: "",
    workspaceId: undefined,
    dirty: false,
    notice: null,
  };
}

export function restoreFileEditState(
  state: FileEditState,
  content: FileSidebarContent | null,
  restoredDraft: RetainedFileDraft | undefined,
): void {
  state.notice = null;
  state.draftContent = restoredDraft?.content ?? null;
  state.savedContent = content?.content ?? "";
  state.hash = restoredDraft?.expectedHash ?? content?.edit?.hash ?? "";
  // A retained draft's identity is authoritative even when the file tab has
  // since been reread through a replacement workspace.
  state.workspaceId = restoredDraft ? restoredDraft.workspaceId : content?.edit?.workspaceId;
  state.dirty = Boolean(restoredDraft);
}

export function beginFileEdit(state: FileEditState, content: FileSidebarContent): void {
  state.savedContent = content.content;
  state.hash = content.edit?.hash ?? "";
  state.workspaceId = content.edit?.workspaceId;
  state.dirty = false;
  state.notice = null;
}

export function captureFileEditChange(
  state: FileEditState,
  content: FileSidebarContent,
  edit: { editing: boolean; content: string; dirty: boolean },
): boolean {
  const draft = captureFileEditorDraft(content, {
    ...edit,
    expectedHash: state.hash,
    workspaceId: state.workspaceId,
  });
  if (!draft) {
    return false;
  }
  state.dirty = draft.dirty;
  state.hash = draft.expectedHash;
  state.workspaceId = draft.workspaceId;
  if (state.notice?.kind === "error") {
    state.notice = null;
  }
  return true;
}

export function discardFileEdit(state: FileEditState, content: FileSidebarContent): void {
  state.draftContent = null;
  state.hash = content.edit?.hash ?? "";
  state.workspaceId = content.edit?.workspaceId;
  state.dirty = false;
  state.notice = null;
  setFileDraft(content, null);
}

type FileEditEditor = {
  currentText: () => string;
  hasEditor: () => boolean;
  contentEquals: (text: string) => boolean | undefined;
};

export function applyFileSaved(
  state: FileEditState,
  content: FileSidebarContent,
  nextContent: string,
  hash: string,
  workspaceId: string | undefined,
  editor: FileEditEditor,
): void {
  const draftContent = editor.currentText();
  state.savedContent = nextContent;
  state.hash = hash;
  state.workspaceId = workspaceId;
  state.dirty = !(editor.contentEquals(nextContent) ?? draftContent === nextContent);
  state.draftContent = !editor.hasEditor() && state.dirty ? draftContent : null;
  setFileDraft(
    content,
    state.dirty
      ? {
          content: draftContent,
          expectedHash: hash,
          ...(workspaceId ? { workspaceId } : {}),
        }
      : null,
  );
  state.notice = null;
  // The retained file tab owns the saved buffer used by later reads and opens.
  content.content = nextContent;
  content.rawText = nextContent;
  if (content.edit) {
    content.edit.hash = hash;
    content.edit.workspaceId = workspaceId;
  }
}

export async function saveFileEdit(params: {
  state: FileEditState;
  content: FileSidebarContent;
  nextContent: string;
  expectedHash: string;
  workspaceId: string | undefined;
  version: number;
  isCurrentVersion: (version: number) => boolean;
  editor: FileEditEditor;
}): Promise<void> {
  const { state, content, nextContent, expectedHash, workspaceId, version, editor } = params;
  if (!content.edit) {
    return;
  }
  const outcome = await content.edit.save({
    content: nextContent,
    expectedHash,
    ...(workspaceId ? { workspaceId } : {}),
  });
  if (!params.isCurrentVersion(version)) {
    return;
  }
  if (outcome.ok) {
    applyFileSaved(state, content, nextContent, outcome.hash, workspaceId, editor);
  } else if (outcome.code === "workspace-changed") {
    // The draft still belongs to the previous workspace and cannot be saved
    // into its replacement; keep it until the user reloads or discards it.
    state.notice = { kind: "workspace-changed" };
  } else if (outcome.code === "conflict") {
    state.notice = { kind: "conflict" };
  } else {
    state.notice = { kind: "error", message: outcome.message };
  }
}
