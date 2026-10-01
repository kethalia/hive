import { toast } from "sonner";
import { type TerminalFileActionHandler, terminalLinkTarget } from "./link-target";

let closeActiveMenu: (() => void) | undefined;

/** A portal outside xterm: its buttons must never send input to the remote TUI. */
export function createTerminalLinkMenu(
  onFileAction?: TerminalFileActionHandler,
  onShow?: (position: { x: number; y: number }) => void,
  onClose?: () => void,
) {
  let menu: HTMLDivElement | undefined;
  let loading = false;
  let position = { x: 0, y: 0 };
  const reposition = () => {
    if (!menu) return;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    menu.style.maxHeight = `${Math.max(0, height - 16)}px`;
    menu.style.maxWidth = `${Math.max(0, width - 16)}px`;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(left + 8, Math.min(position.x, left + width - rect.width - 8))}px`;
    menu.style.top = `${Math.max(top + 8, Math.min(position.y + 10, top + height - rect.height - 8))}px`;
  };
  let targetKey: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restoreFocus: HTMLElement | null = null;
  const cancelTimer = () => {
    clearTimeout(timer);
  };
  const close = () => {
    cancelTimer();
    const wasOpen = Boolean(menu);
    const focused = menu?.contains(document.activeElement);
    menu?.remove();
    menu = undefined;
    loading = false;
    targetKey = undefined;
    if (closeActiveMenu === close) closeActiveMenu = undefined;
    if (wasOpen) onClose?.();
    if (focused) restoreFocus?.focus({ preventScroll: true });
  };
  // Leaving a link cancels a pending hover, but an open menu stays reachable.
  const leave = cancelTimer;
  const show = (
    uri: string,
    x: number,
    y: number,
    focus = false,
    instance = "",
    checking = false,
  ) => {
    const target = terminalLinkTarget(uri);
    if (!target) return;
    const key = `${target.kind}:${target.value}:${instance}:${checking}`;
    cancelTimer();
    if (menu && targetKey === key) {
      if (focus)
        menu.querySelector<HTMLButtonElement>("button:enabled")?.focus({ preventScroll: true });
      return;
    }
    closeActiveMenu?.();
    close();
    closeActiveMenu = close;
    targetKey = key;
    loading = checking;
    onShow?.({ x, y });
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menu = document.createElement("div");
    menu.setAttribute("data-mobile-scroll-allow", "true");
    menu.addEventListener("mousedown", (event) => event.preventDefault());
    menu.setAttribute("role", checking ? "status" : "menu");
    if (checking) menu.setAttribute("aria-live", "polite");
    menu.setAttribute("aria-label", target.kind === "file" ? "File actions" : "Link actions");
    menu.className =
      "fixed z-[100] overflow-y-auto overscroll-contain w-64 max-w-[calc(100vw-16px)] rounded-md border bg-popover p-1 text-popover-foreground shadow-lg text-xs";
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
    if (checking) {
      const status = document.createElement("div");
      status.className = "px-2 py-2 text-muted-foreground";
      status.textContent = "Checking file…";
      menu.append(status);
    } else {
      add(target.kind === "file" ? "Copy path" : "Copy URL", () => {
        void Promise.resolve()
          .then(() => navigator.clipboard.writeText(target.value))
          .then(
            () => toast.success(target.kind === "file" ? "Path copied" : "URL copied"),
            () => toast.error("Could not copy to clipboard"),
          );
      });
      if (target.kind === "url") {
        add("Open URL in browser", () =>
          window.open(target.value, "_blank", "noopener,noreferrer"),
        );
      } else {
        add("Download", () => onFileAction?.(target.value, "download"), !onFileAction);
        add(
          "Open in Files (new window)",
          () => onFileAction?.(target.value, "open"),
          !onFileAction,
        );
        add(
          "Open in Files (new workspace)",
          () => onFileAction?.(target.value, "new-workspace"),
          !onFileAction,
        );
      }
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
    position = { x, y };
    reposition();
    if (focus)
      menu.querySelector<HTMLButtonElement>("button:enabled")?.focus({ preventScroll: true });
  };
  const outside = (event: Event) => {
    if (!menu?.contains(event.target as Node)) close();
  };
  const handleEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", handleEscape);
  window.addEventListener("resize", reposition);
  window.visualViewport?.addEventListener("resize", reposition);
  window.visualViewport?.addEventListener("scroll", reposition);
  return {
    hasFocus: () => Boolean(menu?.contains(document.activeElement)),
    reposition,
    show,
    loading: (uri: string, x: number, y: number, instance = "") =>
      show(uri, x, y, false, instance, true),
    closeLoading: () => {
      if (loading) close();
    },
    hover: (uri: string, x: number, y: number, instance = "") => {
      cancelTimer();
      timer = setTimeout(() => show(uri, x, y, false, instance), 400);
    },
    leave,
    close,
    dispose: () => {
      close();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("scroll", reposition);
    },
  };
}
