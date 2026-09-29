import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { IBuffer, Terminal } from "@xterm/xterm";
import { toast } from "sonner";
import { createTerminalLinkMenu } from "./link-menu";
import {
  type TerminalFileActionHandler,
  type TerminalPathValidator,
  terminalLinkTarget,
} from "./link-target";
import { terminalPathLinkProvider } from "./path-link-provider";

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
export function installTerminalBrowserIntegration(
  term: Terminal,
  {
    allowClipboardWrite = false,
    onFileAction,
    validatePaths = () => [],
  }: {
    allowClipboardWrite?: boolean;
    onFileAction?: TerminalFileActionHandler;
    validatePaths?: TerminalPathValidator;
  } = {},
): () => void {
  const menu = createTerminalLinkMenu(
    onFileAction,
    ({ y }) => {
      anchor = pendingAnchor ?? readAnchor(y, hoveredOpaque);
      pendingAnchor = undefined;
    },
    () => {
      anchor = undefined;
    },
  );
  let validationGeneration = 0;
  let disposed = false;
  const touchProbes = new WeakSet<MouseEvent>();
  let releasedTouch: { x: number; y: number } | undefined;
  let touchTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTouch = () => {
    clearTimeout(touchTimer);
    touchProbe = undefined;
    releasedTouch = undefined;
  };
  let hoveredUri: string | undefined;
  let hoveredOpaque = false;
  let touchProbe: MouseEvent | undefined;
  let pressed: { uri: string; x: number; y: number } | undefined;
  let anchor: { buffer: IBuffer; row: number; text: string; opaque: boolean } | undefined;
  let pendingAnchor: typeof anchor;
  let validationAnchor: typeof anchor;
  let unverifiedHover: { uri: string; click?: { x: number; y: number } } | undefined;
  const cancelPathValidation = () => {
    validationGeneration++;
    unverifiedHover = undefined;
    validationAnchor = undefined;
  };
  const lineText = (buffer: IBuffer, row: number) => {
    let start = row;
    let end = row;
    while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
    while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) end++;
    const lines: string[] = [];
    for (let y = start; y <= end; y++) lines.push(buffer.getLine(y)?.translateToString() ?? "");
    return `${start}:${end}:${lines.join("\n")}`;
  };
  const readAnchor = (clientY: number, opaque = false): typeof anchor => {
    const rect = term.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
    if (!rect || rect.height <= 0) {
      return undefined;
    }
    const buffer = term.buffer.active;
    const row = buffer.viewportY + Math.floor(((clientY - rect.top) * term.rows) / rect.height);
    return { buffer, row, text: lineText(buffer, row), opaque };
  };
  const invalidateLink = () => {
    cancelPathValidation();
    clearTouch();
    anchor = undefined;
    pendingAnchor = undefined;
    hoveredUri = undefined;
    pressed = undefined;
    touchProbe = undefined;
    menu.close();
  };
  // A DOM mouseleave also happens while crossing into the menu. Terminal
  // lifecycle events distinguish that crossing from a stale buffer location.
  const scroll = term.onScroll(invalidateLink);
  const resized = term.onResize(invalidateLink);
  const isInvalid = (location: typeof anchor) =>
    location &&
    // xterm's public cells expose text but not OSC 8 URI metadata. A parsed
    // write may change an OSC link without changing its label, so dismiss it.
    (location.opaque ||
      location.buffer !== term.buffer.active ||
      lineText(location.buffer, location.row) !== location.text);
  const parsed = term.onWriteParsed(() => {
    if (isInvalid(validationAnchor)) cancelPathValidation();
    if (isInvalid(anchor)) {
      invalidateLink();
    } else if (isInvalid(pendingAnchor)) {
      pendingAnchor = undefined;
      hoveredUri = undefined;
      pressed = undefined;
      touchProbe = undefined;
      menu.leave();
    }
  });
  const hoverLink = (event: MouseEvent, uri: string, opaque: boolean) => {
    if (disposed || (touchProbes.has(event) && event !== touchProbe)) return;
    if (touchProbe && event !== touchProbe) return;
    if (!terminalLinkTarget(uri) || event.shiftKey) {
      invalidateLink();
      return;
    }
    pendingAnchor = readAnchor(event.clientY, opaque);
    hoveredUri = uri;
    hoveredOpaque = opaque;
    if (touchProbe && releasedTouch) {
      const touch = releasedTouch;
      clearTouch();
      pressed = undefined;
      menu.show(uri, touch.x, touch.y, true);
      return;
    }
    if (!touchProbe) menu.hover(uri, event.clientX, event.clientY);
    if (touchProbe) pressed = { uri, x: touchProbe.clientX, y: touchProbe.clientY };
  };
  const hover = (event: MouseEvent, uri: string) => {
    cancelPathValidation();
    hoverLink(event, uri, false);
  };
  const leave = () => {
    cancelPathValidation();
    hoveredUri = undefined;
    pendingAnchor = undefined;
    menu.leave();
  };
  const activate = (event: MouseEvent, uri: string, opaque = false) => {
    if (!event.shiftKey) {
      pendingAnchor = readAnchor(event.clientY, opaque);
      menu.show(uri, event.clientX, event.clientY, true);
    }
  };
  const verifiedOscLink = (event: MouseEvent, uri: string, run: () => void, hovering = false) => {
    if (
      event.shiftKey ||
      (touchProbe && event !== touchProbe) ||
      (touchProbes.has(event) && event !== touchProbe)
    )
      return;
    cancelPathValidation();
    const target = terminalLinkTarget(uri);
    if (!target) return;
    const generation = validationGeneration;
    if (target.kind === "url") {
      run();
      return;
    }
    const location = readAnchor(event.clientY);
    validationAnchor = location;
    const candidate = hovering
      ? { uri, click: undefined as { x: number; y: number } | undefined }
      : undefined;
    unverifiedHover = candidate;
    const finish = (existing: string[]) => {
      if (disposed || generation !== validationGeneration) return;
      if (isInvalid(location)) {
        cancelPathValidation();
        return;
      }
      unverifiedHover = undefined;
      validationAnchor = undefined;
      if (!existing.includes(target.value)) return;
      if (candidate?.click) {
        activate(
          new MouseEvent("click", { clientX: candidate.click.x, clientY: candidate.click.y }),
          uri,
          true,
        );
      } else run();
    };
    try {
      const result = validatePaths([target.value]);
      if (Array.isArray(result)) finish(result);
      else void result.then(finish, () => finish([]));
    } catch {
      finish([]);
    }
  };
  // OSC 8 metadata is not exposed by public cells. Cancel checks when that
  // metadata is written, while allowing unrelated output to continue.
  const oscLinks = term.parser.registerOscHandler(8, () => {
    cancelPathValidation();
    return false;
  });
  const previousLinkHandler = term.options.linkHandler;
  term.options.linkHandler = {
    activate: (event, uri) => {
      verifiedOscLink(event, uri, () => activate(event, uri, true));
    },
    hover: (event, uri) => verifiedOscLink(event, uri, () => hoverLink(event, uri, true), true),
    leave,
    allowNonHttpProtocols: true,
  };
  const links = new WebLinksAddon(activate, { hover, leave });
  const clipboard = allowClipboardWrite
    ? new ClipboardAddon(undefined, terminalClipboardProvider)
    : undefined;
  term.loadAddon(links);
  const pathProvider = terminalPathLinkProvider(term, { activate, hover, leave }, validatePaths);
  const paths = term.registerLinkProvider(pathProvider);
  if (clipboard) term.loadAddon(clipboard);
  const element = term.element;

  // Link clicks belong to the browser, not the remote application's mouse handler.
  // Shift-drag remains available for terminal selection.
  const mouseDown = (event: MouseEvent) => {
    pressed = undefined;
    menu.close();
    if (event.button !== 0 || event.shiftKey) {
      cancelPathValidation();
      return;
    }
    const uri = unverifiedHover?.uri ?? hoveredUri;
    if (!uri) return;
    pressed = { uri, x: event.clientX, y: event.clientY };
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const mouseUp = (event: MouseEvent) => {
    const link = pressed;
    pressed = undefined;
    if (!link) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (Math.hypot(event.clientX - link.x, event.clientY - link.y) >= 8) {
      cancelPathValidation();
      return;
    }
    if (unverifiedHover?.uri === link.uri) {
      unverifiedHover.click = { x: event.clientX, y: event.clientY };
      return;
    }
    if (hoveredUri === link.uri) {
      menu.show(link.uri, event.clientX, event.clientY, true);
    }
  };
  const touchStart = (event: TouchEvent) => {
    cancelPathValidation();
    clearTouch();
    pressed = undefined;
    touchProbe = undefined;
    hoveredUri = undefined;
    if (event.touches.length !== 1 || element?.closest('[data-terminal-selection-mode="true"]'))
      return;
    const touch = event.touches[0];
    // xterm's public link providers resolve on mouse movement; touch has no hover.
    const screen = element?.querySelector(".xterm-screen");
    touchProbe = new MouseEvent("mousemove", {
      clientX: touch.clientX,
      clientY: touch.clientY,
    });
    touchProbes.add(touchProbe);
    // xterm retains its last buffer cell on mouseleave. Visit a different column
    // first so repeated taps trigger a fresh lookup. Keep probes on the screen:
    // bubbling would send synthetic mouse motion to the remote application.
    const rect = screen?.getBoundingClientRect();
    if (rect && rect.width > 0) {
      const cellWidth = rect.width / term.cols;
      const resetX =
        touch.clientX <= rect.left + cellWidth
          ? rect.right - cellWidth / 2
          : rect.left + cellWidth / 2;
      screen?.dispatchEvent(
        new MouseEvent("mousemove", {
          clientX: resetX,
          clientY: touch.clientY,
        }),
      );
    }
    screen?.dispatchEvent(new MouseEvent("mouseleave"));
    screen?.dispatchEvent(touchProbe);
    touchTimer = setTimeout(clearTouch, 5000);
  };
  const touchEnd = (event: TouchEvent) => {
    const link = pressed;
    pressed = undefined;
    const touch = event.changedTouches[0];
    if (
      !link &&
      touchProbe &&
      (unverifiedHover || pathProvider.isValidationPending(touchProbe)) &&
      touch &&
      Math.hypot(touch.clientX - touchProbe.clientX, touch.clientY - touchProbe.clientY) < 8
    ) {
      releasedTouch = { x: touch.clientX, y: touch.clientY };
      // Suppress the compatibility mouse events while the touch lookup is pending.
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    clearTouch();
    if (
      !link ||
      !touch ||
      hoveredUri !== link.uri ||
      Math.hypot(touch.clientX - link.x, touch.clientY - link.y) >= 8
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    menu.show(link.uri, touch.clientX, touch.clientY, true);
  };
  const cancel = () => {
    cancelPathValidation();
    clearTouch();
    touchProbe = undefined;
    pressed = undefined;
    menu.close();
  };
  const touchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (
      !touchProbe ||
      event.touches.length !== 1 ||
      Math.hypot(touch.clientX - touchProbe.clientX, touch.clientY - touchProbe.clientY) >= 8
    ) {
      cancel();
    }
  };
  const cancelValidation = () => {
    cancelPathValidation();
    clearTouch();
  };
  const escapeValidation = (event: KeyboardEvent) => {
    if (event.key === "Escape") cancelValidation();
  };
  const pointerValidation = (event: PointerEvent) => {
    if (
      unverifiedHover &&
      element?.contains(event.target as Node) &&
      event.button === 0 &&
      !event.shiftKey &&
      event.pointerType !== "touch"
    )
      return;
    cancelValidation();
  };
  document.addEventListener("pointerdown", pointerValidation, true);
  document.addEventListener("keydown", escapeValidation);
  element?.addEventListener("wheel", invalidateLink, { passive: true });
  element?.addEventListener("mousedown", mouseDown, true);
  element?.addEventListener("mouseup", mouseUp, true);
  element?.addEventListener("touchstart", touchStart, { passive: true });
  element?.addEventListener("touchend", touchEnd, { passive: false });
  element?.addEventListener("touchmove", touchMove, { passive: true });
  element?.addEventListener("touchcancel", cancel);
  element?.addEventListener("mouseleave", leave);
  return () => {
    disposed = true;
    cancelPathValidation();
    clearTouch();
    document.removeEventListener("pointerdown", pointerValidation, true);
    document.removeEventListener("keydown", escapeValidation);
    element?.removeEventListener("wheel", invalidateLink);
    element?.removeEventListener("mousedown", mouseDown, true);
    element?.removeEventListener("mouseup", mouseUp, true);
    element?.removeEventListener("touchstart", touchStart);
    element?.removeEventListener("touchend", touchEnd);
    element?.removeEventListener("touchmove", touchMove);
    element?.removeEventListener("touchcancel", cancel);
    element?.removeEventListener("mouseleave", leave);
    term.options.linkHandler = previousLinkHandler;
    oscLinks.dispose();
    resized.dispose();
    scroll.dispose();
    parsed.dispose();
    paths.dispose();
    menu.dispose();
    links.dispose();
    clipboard?.dispose();
  };
}
