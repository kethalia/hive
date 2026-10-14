/** Only the text grid owns selection gestures; scrollbar and controls do not. */
export function isTerminalSelectionSurface(
  screen: HTMLElement | null | undefined,
  target: EventTarget | null,
  point: { clientX: number; clientY: number },
): boolean {
  if (!screen || !(target instanceof Node) || !screen.contains(target)) return false;
  const element = target instanceof Element ? target : target.parentElement;
  if (element?.closest(".xterm-helpers")) {
    // Chromium touch hit testing can retarget a finger to xterm's transparent
    // textarea near the cursor. That proxy belongs to the grid; visible native
    // input controls and measurement helpers still do not.
    const proxy = element.closest(".xterm-helper-textarea");
    if (!(proxy instanceof HTMLElement) || getComputedStyle(proxy).opacity !== "0") return false;
  }
  const rect = screen.getBoundingClientRect();
  return (
    point.clientX >= rect.left &&
    point.clientX < rect.right &&
    point.clientY >= rect.top &&
    point.clientY < rect.bottom
  );
}
