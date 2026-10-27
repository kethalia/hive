"use client";
import { useEffect, useState } from "react";
import { MobileTerminalControls } from "@/components/terminal/MobileTerminalControls";
import { useKeybindings } from "@/hooks/useKeybindings";
import { useTerminalClipboardFeedback } from "@/hooks/useTerminalClipboardFeedback";
import {
  copyTerminalSelection,
  getTerminalSelectionText,
  pasteClipboardApiToTerminal,
} from "@/lib/terminal/actions";
import { handleTerminalPasteOutcome } from "@/lib/terminal/clipboard";
import { terminalFontSizeScope } from "@/lib/terminal/font-size";

export function GeneralWorkspaceMobileControls({
  workspaceId,
  sessionName,
  isKeyboardVisible,
}: {
  workspaceId: string;
  sessionName: string;
  isKeyboardVisible: boolean;
}) {
  const { activeTerminal, activeSend } = useKeybindings();
  const [hasSelection, setHasSelection] = useState(false);
  const { onStatus, busyAction, reset } = useTerminalClipboardFeedback();
  useEffect(() => {
    reset();
    const update = () =>
      setHasSelection(activeTerminal ? Boolean(getTerminalSelectionText(activeTerminal)) : false);
    update();
    document.addEventListener("selectionchange", update);
    const listener = activeTerminal?.onSelectionChange(update);
    return () => {
      listener?.dispose();
      document.removeEventListener("selectionchange", update);
    };
  }, [activeTerminal, reset]);
  return (
    <MobileTerminalControls
      fontSizeScope={terminalFontSizeScope(workspaceId, sessionName)}
      isKeyboardVisible={isKeyboardVisible}
      hasSelection={hasSelection}
      onCopy={
        activeTerminal
          ? () => {
              copyTerminalSelection(activeTerminal, { onStatus });
            }
          : undefined
      }
      onPaste={
        activeSend
          ? () => {
              pasteClipboardApiToTerminal(activeTerminal, activeSend, { workspaceId, onStatus });
            }
          : undefined
      }
      onUploadFiles={
        activeSend
          ? async (files) => {
              await handleTerminalPasteOutcome(
                { kind: "asset-files", files },
                { term: activeTerminal, send: activeSend, workspaceId, onStatus },
              );
            }
          : undefined
      }
      clipboardBusyAction={busyAction}
    />
  );
}
