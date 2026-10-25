import type { PANE_CONTROL_SHORTCUTS } from "@/lib/keyboard-shortcuts";

export const TERMINAL_CONTROL_BUTTON_CLASS_NAME =
  "size-8 min-h-8 shrink-0 p-0 max-[1024px]:size-11 max-[1024px]:min-h-11 pointer-coarse:size-11 pointer-coarse:min-h-11";

const FRAME_SELECTOR = '[data-terminal-audio-frame="true"], [data-terminal-audio-shell="true"]';
const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [data-slot="popover-content"]';

function visible(element: Element | null): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element.isConnected &&
    !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
    element.getClientRects().length > 0
  );
}

/** Execute the same button action as a click, scoped to the visible focused pane. */
export function activatePaneControl(
  control: keyof typeof PANE_CONTROL_SHORTCUTS,
  terminalElement?: HTMLElement,
): boolean {
  // Do not close or change a pane underneath an open dialog/menu.
  if ([...document.querySelectorAll(OVERLAY_SELECTOR)].some(visible)) return true;
  const focused = document.activeElement?.closest(FRAME_SELECTOR) ?? null;
  const terminalFrame = terminalElement?.closest(FRAME_SELECTOR) ?? null;
  const frame = visible(focused)
    ? focused
    : visible(terminalFrame) && terminalFrame.dataset.active !== "false"
      ? terminalFrame
      : [...document.querySelectorAll(FRAME_SELECTOR)].find(
          (element) => visible(element) && element.dataset.active === "true",
        );
  const button = frame?.querySelector<HTMLButtonElement>(
    `button[data-terminal-control="${control}"]`,
  );
  if (!button || button.disabled || !visible(button)) return true;
  button.click();
  return false;
}
