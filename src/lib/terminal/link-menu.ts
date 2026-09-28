import { toast } from "sonner";
import { type TerminalFileActionHandler, terminalLinkTarget } from "./link-target";

let closeActiveMenu: (() => void) | undefined;

/** A portal outside xterm: its buttons must never send input to the remote TUI. */
export function createTerminalLinkMenu(
  onFileAction?: TerminalFileActionHandler,
  onShow?: (position: { x: number; y: number }) => void,
) {
  let menu: HTMLDivElement | undefined;
  let targetKey: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restoreFocus: HTMLElement | null = null;
  const cancelTimer = () => {
    clearTimeout(timer);
  };
  const close = () => {
    cancelTimer();
    const focused = menu?.contains(document.activeElement);
    menu?.remove();
    menu = undefined;
    targetKey = undefined;
    if (closeActiveMenu === close) closeActiveMenu = undefined;
    if (focused) restoreFocus?.focus({ preventScroll: true });
  };
  // Leaving a link cancels a pending hover, but an open menu stays reachable.
  const leave = cancelTimer;
  const show = (uri: string, x: number, y: number, focus = false) => {
    const target = terminalLinkTarget(uri);
    if (!target) return;
    const key = `${target.kind}:${target.value}`;
    cancelTimer();
    if (menu && targetKey === key) {
      if (focus) menu.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
      return;
    }
    closeActiveMenu?.();
    close();
    closeActiveMenu = close;
    targetKey = key;
    onShow?.({ x, y });
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", target.kind === "file" ? "File actions" : "Link actions");
    menu.className =
      "fixed z-[100] w-64 max-w-[calc(100vw-16px)] rounded-md border bg-popover p-1 text-popover-foreground shadow-lg text-xs";
    menu.addEventListener("pointerenter", cancelTimer);
    menu.addEventListener("focusin", cancelTimer);
    const label = document.createElement("div");
    label.className = "truncate px-2 py-1 text-xs text-muted-foreground";
    label.textContent = target.value;
    label.title = target.value;
    menu.append(label);
    const add = (title: string, action: () => void, disabled = false) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.textContent = title;
      button.disabled = disabled;
      button.className =
        "block min-h-7 w-full rounded px-2 py-1 [@media(any-pointer:coarse)]:min-h-11 text-left hover:bg-accent focus:bg-accent focus:outline-none disabled:opacity-50";
      button.addEventListener("click", () => {
        close();
        action();
      });
      menu?.append(button);
    };
    add(target.kind === "file" ? "Copy path" : "Copy URL", () => {
      void Promise.resolve()
        .then(() => navigator.clipboard.writeText(target.value))
        .then(
          () => toast.success(target.kind === "file" ? "Path copied" : "URL copied"),
          () => toast.error("Could not copy to clipboard"),
        );
    });
    if (target.kind === "url") {
      add("Open URL in browser", () => window.open(target.value, "_blank", "noopener,noreferrer"));
    } else {
      add("Download", () => onFileAction?.(target.value, "download"), !onFileAction);
      add("Open in Files (new window)", () => onFileAction?.(target.value, "open"), !onFileAction);
      add(
        "Open in Files (new workspace)",
        () => onFileAction?.(target.value, "new-workspace"),
        !onFileAction,
      );
    }
    menu.addEventListener("keydown", (event) => {
      event.stopPropagation();
      const buttons = Array.from(menu?.querySelectorAll<HTMLButtonElement>("button:enabled") ?? []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape" || event.key === "Tab") {
        close();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    });
    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y + 10, window.innerHeight - rect.height - 8))}px`;
    if (focus) menu.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  };
  const outside = (event: Event) => {
    if (!menu?.contains(event.target as Node)) close();
  };
  const handleEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", handleEscape);
  window.addEventListener("resize", close);
  return {
    show,
    hover: (uri: string, x: number, y: number) => {
      cancelTimer();
      timer = setTimeout(() => show(uri, x, y), 400);
    },
    leave,
    close,
    dispose: () => {
      close();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", close);
    },
  };
}
