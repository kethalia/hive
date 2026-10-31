"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type DockAction, WorkspaceDock } from "@/components/workspaces/dock/workspace-dock";
import { WorkspaceDockOverlay } from "@/components/workspaces/dock/workspace-dock-overlay";
import { useKeybindings, useRegisterKeybindingHelp } from "@/hooks/useKeybindings";
import { useModalOpen } from "@/hooks/useModalOpen";
import { useTerminalClipboardFeedback } from "@/hooks/useTerminalClipboardFeedback";
import { useTerminalFontStep } from "@/hooks/useTerminalFontStep";
import {
  copyTerminalSelection,
  getTerminalSelectionText,
  pasteClipboardApiToTerminal,
} from "@/lib/terminal/actions";
import { handleTerminalPasteOutcome } from "@/lib/terminal/clipboard";
import { terminalFontSizeScope } from "@/lib/terminal/font-size";
import { openGlobalCommandPalette } from "@/lib/terminal/global-command-palette";
import { openKeybindingHelp } from "@/lib/terminal/help-overlay";
import {
  getMobileModifiers,
  NO_MOBILE_MODIFIERS,
  setMobileModifiers,
  subscribeMobileModifiers,
} from "@/lib/terminal/mobile-modifiers";
import { type GeneralBoard, MAX_GENERAL_BOARDS } from "@/lib/workspaces/general-workspace";

const DOCK_HELP = (
  <p className="rounded-md border p-3 text-xs text-muted-foreground">
    Alt+Shift+D expands or minimises the workspace dock. Drag Move or the collapsed button to an
    edge. Arrow keys move along that edge; Shift+Arrow chooses an edge, Home/End move to corners,
    and Escape cancels dragging. Manual expansion resumes auto-hide after inactivity.
  </p>
);

export function GeneralWorkspaceDock({
  boards,
  activeBoardKey,
  terminal,
  onSelect,
  onCreate,
  onRemove,
}: {
  boards: readonly GeneralBoard[];
  activeBoardKey: string;
  terminal?: { workspaceId: string; sessionName: string };
  onSelect: (key: string) => void;
  onCreate: () => void;
  onRemove: (key: string) => void;
}) {
  const { activeTerminal, activeSend } = useKeybindings();
  const modalOpen = useModalOpen();
  const [hasSelection, setHasSelection] = useState(false);
  const [picking, setPicking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { onStatus, busyAction, reset } = useTerminalClipboardFeedback();
  const scope = terminal ? terminalFontSizeScope(terminal.workspaceId, terminal.sessionName) : null;
  const font = useTerminalFontStep(scope);
  // Never send to a stale terminal when a non-terminal pane/board becomes active.
  const term = terminal ? activeTerminal : null;
  const send = terminal ? activeSend : null;
  const modifiers = useSyncExternalStore(
    subscribeMobileModifiers,
    () => getMobileModifiers(term),
    () => NO_MOBILE_MODIFIERS,
  );
  useRegisterKeybindingHelp("workspace-dock", DOCK_HELP);
  useEffect(() => {
    const node = input.current;
    const cancel = () => setPicking(false);
    node?.addEventListener("cancel", cancel);
    return () => node?.removeEventListener("cancel", cancel);
  }, []);
  useEffect(() => {
    reset();
    const update = () => setHasSelection(term ? Boolean(getTerminalSelectionText(term)) : false);
    update();
    document.addEventListener("selectionchange", update);
    const listener = term?.onSelectionChange(update);
    return () => {
      listener?.dispose();
      document.removeEventListener("selectionchange", update);
      setMobileModifiers(term, NO_MOBILE_MODIFIERS);
    };
  }, [term, reset]);

  const busy = Boolean(busyAction) || uploading || picking;
  const unavailable = "Open and focus a terminal to use this control.";
  const disabledActions: Partial<Record<DockAction, string>> = {
    ...(!term || !hasSelection ? { copy: "Select terminal text to copy." } : {}),
    ...(!send ? { paste: unavailable, upload: unavailable } : {}),
    ...(!font.canDecrease ? { "font-decrease": "Font size cannot be decreased." } : {}),
    ...(!font.canIncrease ? { "font-increase": "Font size cannot be increased." } : {}),
    ...(busy
      ? {
          copy: "Clipboard action in progress.",
          paste: "Clipboard action in progress.",
          upload: "Clipboard action in progress.",
        }
      : {}),
  };
  function action(id: DockAction) {
    if (disabledActions[id]) return;
    if (id === "copy" && term) copyTerminalSelection(term, { onStatus });
    else if (id === "paste" && send && terminal)
      void pasteClipboardApiToTerminal(term, send, { workspaceId: terminal.workspaceId, onStatus });
    else if (id === "upload") {
      setPicking(true);
      input.current?.click();
    } else if (id === "font-decrease") font.decrease();
    else if (id === "font-increase") font.increase();
  }
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label="Choose files to upload"
        onChange={async (event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          setPicking(false);
          if (!files.length || !send || !terminal || uploading) return;
          setUploading(true);
          try {
            await handleTerminalPasteOutcome(
              { kind: "asset-files", files },
              { term, send, workspaceId: terminal.workspaceId, onStatus },
            );
          } finally {
            setUploading(false);
          }
        }}
      />
      <WorkspaceDockOverlay blocked={modalOpen || busy}>
        <WorkspaceDock
          workspaces={boards.map((board) => ({ id: board.key, name: board.name }))}
          activeWorkspaceId={activeBoardKey}
          onWorkspaceSelect={onSelect}
          onWorkspaceCreate={onCreate}
          onWorkspaceRemove={onRemove}
          canCreateWorkspace={boards.length < MAX_GENERAL_BOARDS}
          onAppsOpen={openGlobalCommandPalette}
          onKeybindsOpen={openKeybindingHelp}
          keysDisabled={!term || !send}
          preserveTerminalFocus
          modifiers={modifiers}
          onModifiersChange={(next) => setMobileModifiers(term, next)}
          onKeyPress={({ sequence }) => send?.(sequence)}
          onAction={action}
          disabledActions={disabledActions}
          busyActions={uploading ? ["upload"] : busyAction ? [busyAction] : []}
        />
      </WorkspaceDockOverlay>
    </>
  );
}
