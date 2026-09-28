import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { Terminal } from "@xterm/xterm";
import { toast } from "sonner";

export function openTerminalLink(uri: string): void {
  try {
    const url = new URL(uri);
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    window.open(url.href, "_blank", "noopener,noreferrer");
  } catch {
    // Terminal output is not necessarily a valid URL.
  }
}

export const terminalClipboardProvider: IClipboardProvider = {
  // Remote programs may request writes, but cannot read the local clipboard.
  readText: () => "",
  writeText: (_selection, text) => {
    if (!text || text.length > 1024 * 1024) return;
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast.success("Copied terminal text");
      } catch {
        // Safari and other browsers may require a fresh local user gesture.
        toast("Terminal text is ready to copy", {
          id: "terminal-clipboard-copy",
          duration: 15000,
          action: { label: "Copy", onClick: () => void copy() },
        });
      }
    };
    // Do not block the terminal parser on a browser permission prompt.
    void copy();
  },
};

/** Use standard terminal links and clipboard protocols, including in fullscreen TUIs. */
export function installTerminalBrowserIntegration(term: Terminal): () => void {
  let hoveredUri: string | undefined;
  let pressed: { uri: string; x: number; y: number } | undefined;
  const hover = (_event: MouseEvent, uri: string) => {
    hoveredUri = uri;
  };
  const leave = () => {
    hoveredUri = undefined;
  };
  const activate = (event: MouseEvent, uri: string) => {
    if (!event.shiftKey) openTerminalLink(uri);
  };
  const previousLinkHandler = term.options.linkHandler;
  term.options.linkHandler = { activate, hover, leave, allowNonHttpProtocols: false };
  const links = new WebLinksAddon(activate, { hover, leave });
  const clipboard = new ClipboardAddon(undefined, terminalClipboardProvider);
  term.loadAddon(links);
  term.loadAddon(clipboard);
  const element = term.element;

  // Link clicks belong to the browser, not the remote application's mouse handler.
  // Shift-drag remains available for terminal selection.
  const mouseDown = (event: MouseEvent) => {
    pressed = undefined;
    if (!hoveredUri || event.button !== 0 || event.shiftKey) return;
    pressed = { uri: hoveredUri, x: event.clientX, y: event.clientY };
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const mouseUp = (event: MouseEvent) => {
    const link = pressed;
    pressed = undefined;
    if (!link) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (hoveredUri === link.uri && Math.hypot(event.clientX - link.x, event.clientY - link.y) < 8) {
      openTerminalLink(link.uri);
    }
  };
  const touchStart = (event: TouchEvent) => {
    pressed = undefined;
    if (event.touches.length !== 1 || element?.closest('[data-terminal-selection-mode="true"]'))
      return;
    const touch = event.touches[0];
    // xterm's public link providers resolve on mouse movement; touch has no hover.
    const screen = element?.querySelector(".xterm-screen");
    screen?.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
      }),
    );
    if (hoveredUri) pressed = { uri: hoveredUri, x: touch.clientX, y: touch.clientY };
  };
  const touchEnd = (event: TouchEvent) => {
    const link = pressed;
    pressed = undefined;
    const touch = event.changedTouches[0];
    if (!link || !touch || Math.hypot(touch.clientX - link.x, touch.clientY - link.y) >= 8) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openTerminalLink(link.uri);
  };
  const cancel = () => {
    pressed = undefined;
  };
  element?.addEventListener("mousedown", mouseDown, true);
  element?.addEventListener("mouseup", mouseUp, true);
  element?.addEventListener("touchstart", touchStart, { passive: true });
  element?.addEventListener("touchend", touchEnd, { passive: false });
  element?.addEventListener("touchmove", cancel, { passive: true });
  element?.addEventListener("touchcancel", cancel);
  element?.addEventListener("mouseleave", leave);
  return () => {
    element?.removeEventListener("mousedown", mouseDown, true);
    element?.removeEventListener("mouseup", mouseUp, true);
    element?.removeEventListener("touchstart", touchStart);
    element?.removeEventListener("touchend", touchEnd);
    element?.removeEventListener("touchmove", cancel);
    element?.removeEventListener("touchcancel", cancel);
    element?.removeEventListener("mouseleave", leave);
    term.options.linkHandler = previousLinkHandler;
    links.dispose();
    clipboard.dispose();
  };
}
