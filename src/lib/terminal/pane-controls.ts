import type { PANE_CONTROL_SHORTCUTS } from "@/lib/keyboard-shortcuts";

export const TERMINAL_CONTROL_BUTTON_CLASS_NAME =
  "size-8 min-h-8 shrink-0 rounded-sm p-0 max-[1024px]:size-11 max-[1024px]:min-h-11 pointer-coarse:size-11 pointer-coarse:min-h-11";

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
  // Selecting a nonterminal pane can leave DOM focus in the old terminal until
  // the next frame. Never let that stale focus override the selected window.
  const frame =
    visible(focused) && focused.dataset.active !== "false"
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

export const TERMINAL_CONTROL_HOVER_CLASS_NAME =
  "border border-transparent transition-colors hover:bg-white/10 dark:hover:bg-white/10 aria-expanded:bg-white/10 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

export const TERMINAL_CLOSE_HOVER_CLASS_NAME =
  "bg-destructive/15 text-destructive hover:bg-destructive hover:text-white dark:hover:text-background dark:bg-destructive/15 dark:hover:bg-destructive";
