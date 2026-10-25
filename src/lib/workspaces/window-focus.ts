/** Dialogs may replace one another (search → creation); never steal the new dialog's focus. */
export function workspaceFocusTarget(): HTMLElement | false {
  if (document.querySelector('[role="dialog"][data-open]')) return false;
  return (
    document.querySelector<HTMLElement>(
      '[data-workspace-window-id] [data-terminal-audio-frame="true"][data-active="true"]',
    ) ?? false
  );
}

export function focusWorkspaceWindow() {
  const frame = workspaceFocusTarget();
  if (!frame) return;
  const terminal = window.matchMedia("(pointer: coarse)").matches
    ? null
    : frame.querySelector<HTMLElement>(".xterm-helper-textarea");
  (terminal ?? frame).focus({ preventScroll: true });
}

/** Resolve after React commits the selected pane, not during the old dialog's cleanup. */
export function restoreWorkspaceFocus(): false {
  requestAnimationFrame(focusWorkspaceWindow);
  return false;
}
