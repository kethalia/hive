import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { IBuffer, IBufferRange, Terminal } from "@xterm/xterm";
import { toast } from "sonner";
import { createTerminalLinkMenu } from "./link-menu";
import {
  type TerminalFileActionHandler,
  type TerminalPathValidator,
  terminalLinkTarget,
} from "./link-target";
import { terminalPathLinkProvider } from "./path-link-provider";
import {
  createTerminalPathValidator,
  TERMINAL_PATH_VALIDATION_TIMEOUT_MS,
} from "./path-validation";

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
  const checkPaths = createTerminalPathValidator(validatePaths);
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
  let suppressHover = false;
  let hoveredUri: string | undefined;
  let hoveredOpaque = false;
  let hoveredInstance = "";
  let pendingPlainPress: ReturnType<typeof pathProvider.pendingLinkAt>;
  let pendingPlainClick: { x: number; y: number } | undefined;
  const instanceKey = (event: MouseEvent, range?: IBufferRange) =>
    range?.start && range?.end
      ? `${range.start.x}:${range.start.y}:${range.end.x}:${range.end.y}`
      : `row:${readAnchor(event.clientY)?.row ?? event.clientY}`;
  let touchProbe: MouseEvent | undefined;
  let pressed: { uri: string; x: number; y: number } | undefined;
  let anchor: { buffer: IBuffer; row: number; text: string; opaque: boolean } | undefined;
  let pendingAnchor: typeof anchor;
  let validationAnchor: typeof anchor;
  let unverifiedHover: { uri: string; click?: { x: number; y: number } } | undefined;
  const cancelPathValidation = () => {
    validationGeneration++;
    menu.closeLoading();
    pendingPlainPress = undefined;
    pendingPlainClick = undefined;
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
  // There is no reliable CWD event in every shell/TUI. Conservatively expire
  // relative checks on input and output; a paint-only refresh retains them.
  const input = term.onData((data) => {
    // Link hover runs before xterm emits the mouse report for that movement.
    // Mouse tracking must not cancel the check it just started. Keep forwarding
    // these reports to the TUI; output still invalidates relative paths.
    const mouseReport =
      (data.startsWith("\x1b[<") && /^\d+;\d+;\d+[Mm]$/.test(data.slice(3))) ||
      (data.startsWith("\x1b[M") && Array.from(data.slice(3)).length === 3) ||
      (data.startsWith("\x1b[") && /^\d+;\d+;\d+M$/.test(data.slice(2)));
    if (!mouseReport) checkPaths.invalidateRelativePaths();
  });
  const parsed = term.onWriteParsed(() => {
    // Output can be unrelated progress on another row. Let pending checks
    // finish; the provider/anchor snapshots below reject changed link rows.
    checkPaths.invalidateRelativePaths({ cancelPending: false });
    if (isInvalid(validationAnchor)) cancelPathValidation();
    if (isInvalid(anchor)) {
      invalidateLink();
    } else if (isInvalid(pendingAnchor)) {
      pendingAnchor = undefined;
      hoveredUri = undefined;
      pressed = undefined;
      touchProbe = undefined;
      menu.leave();
      menu.closeLoading();
    }
  });
  const hoverLink = (event: MouseEvent, uri: string, opaque: boolean, range?: IBufferRange) => {
    if (disposed || (touchProbes.has(event) && event !== touchProbe)) return;
    if (touchProbe && event !== touchProbe) return;
    if (!terminalLinkTarget(uri) || event.shiftKey) {
      invalidateLink();
      return;
    }
    pendingAnchor = readAnchor(event.clientY, opaque);
    hoveredUri = uri;
    hoveredOpaque = opaque;
    hoveredInstance = instanceKey(event, range);
    // Remember confirmed links for click interception even after Escape. Only
    // suppress opening the popup, not the current link's interaction state.
    if (suppressHover && !touchProbe) return;
    if (touchProbe && releasedTouch) {
      const touch = releasedTouch;
      clearTouch();
      pressed = undefined;
      menu.show(uri, touch.x, touch.y, true, hoveredInstance);
      return;
    }
    if (!touchProbe) {
      if (terminalLinkTarget(uri)?.kind === "file")
        menu.show(uri, event.clientX, event.clientY, false, hoveredInstance);
      else menu.hover(uri, event.clientX, event.clientY, hoveredInstance);
    }
    if (touchProbe) pressed = { uri, x: touchProbe.clientX, y: touchProbe.clientY };
  };
  const hover = (event: MouseEvent, uri: string, range?: IBufferRange) => {
    if (!pendingPlainClick && !pendingPlainPress) cancelPathValidation();
    hoverLink(event, uri, false, range);
  };
  const leave = () => {
    cancelPathValidation();
    hoveredUri = undefined;
    pendingAnchor = undefined;
    menu.leave();
  };
  const activate = (event: MouseEvent, uri: string, opaque = false, range?: IBufferRange) => {
    if (!event.shiftKey) {
      pendingAnchor = readAnchor(event.clientY, opaque);
      menu.show(uri, event.clientX, event.clientY, true, instanceKey(event, range));
    }
  };
  const verifiedOscLink = (
    event: MouseEvent,
    uri: string,
    run: () => void,
    hovering = false,
    range?: IBufferRange,
  ) => {
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
      if (!existing.includes(target.value)) {
        menu.closeLoading();
        clearTouch();
        return;
      }
      if (candidate?.click) {
        activate(
          new MouseEvent("click", { clientX: candidate.click.x, clientY: candidate.click.y }),
          uri,
          true,
          range,
        );
      } else run();
    };
    try {
      const result = checkPaths([target.value]);
      if (Array.isArray(result)) finish(result);
      else {
        if (!touchProbe && (!hovering || !suppressHover)) {
          pendingAnchor = location;
          menu.loading(uri, event.clientX, event.clientY, instanceKey(event, range));
        }
        void result.then(finish, () => finish([]));
      }
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
    activate: (event, uri, range) => {
      verifiedOscLink(event, uri, () => activate(event, uri, true, range), false, range);
    },
    hover: (event, uri, range) =>
      verifiedOscLink(event, uri, () => hoverLink(event, uri, true, range), true, range),
    leave,
    allowNonHttpProtocols: true,
  };
  const links = new WebLinksAddon(activate, { hover, leave });
  const clipboard = allowClipboardWrite
    ? new ClipboardAddon(undefined, terminalClipboardProvider)
    : undefined;
  term.loadAddon(links);
  const pathProvider = terminalPathLinkProvider(
    term,
    { activate: (event, uri, range) => activate(event, uri, false, range), hover, leave },
    checkPaths,
  );
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
    pendingPlainPress = pathProvider.pendingLinkAt(event);
    const uri = unverifiedHover?.uri ?? pendingPlainPress?.link.text ?? hoveredUri;
    if (!uri) return;
    pressed = { uri, x: event.clientX, y: event.clientY };
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const mouseUp = (event: MouseEvent) => {
    const link = pressed;
    const pending = pendingPlainPress;
    pendingPlainPress = undefined;
    pressed = undefined;
    if (!link) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (Math.hypot(event.clientX - link.x, event.clientY - link.y) >= 8) {
      cancelPathValidation();
      return;
    }
    if (pending) {
      const click = { x: event.clientX, y: event.clientY };
      pendingPlainClick = click;
      showPendingPlain(event);
      void pending.ready.then((valid) => {
        if (disposed || pendingPlainClick !== click) return;
        pendingPlainClick = undefined;
        if (valid) activate(event, pending.link.text, false, pending.link.range);
      });
      return;
    }
    if (unverifiedHover?.uri === link.uri) {
      unverifiedHover.click = { x: event.clientX, y: event.clientY };
      pendingAnchor = readAnchor(event.clientY);
      menu.loading(link.uri, event.clientX, event.clientY);
      return;
    }
    if (hoveredUri === link.uri) {
      menu.show(link.uri, event.clientX, event.clientY, true, hoveredInstance);
    }
  };
  const touchStart = (event: TouchEvent) => {
    suppressHover = false;
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
      const resetProbe = new MouseEvent("mousemove", {
        clientX: resetX,
        clientY: touch.clientY,
      });
      touchProbes.add(resetProbe);
      screen?.dispatchEvent(resetProbe);
    }
    screen?.dispatchEvent(new MouseEvent("mouseleave"));
    screen?.dispatchEvent(touchProbe);
    touchTimer = setTimeout(clearTouch, TERMINAL_PATH_VALIDATION_TIMEOUT_MS + 1000);
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
      if (unverifiedHover) {
        pendingAnchor = readAnchor(touch.clientY);
        menu.loading(unverifiedHover.uri, touch.clientX, touch.clientY);
      } else showPendingPlain(touchProbe);
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
    menu.show(link.uri, touch.clientX, touch.clientY, true, hoveredInstance);
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
    // xterm may deliver a provider hover after dismissal, even without a new
    // pointer gesture. Wait for an actual move or tap before accepting it.
    suppressHover = true;
    cancelPathValidation();
    clearTouch();
  };
  const escapeValidation = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (unverifiedHover && !touchProbe) {
      // Keep the pending OSC lookup available to intercept a stationary click.
      // Its result may update hover state, but must not reopen the dismissed UI.
      suppressHover = true;
      unverifiedHover.click = undefined;
      menu.closeLoading();
    } else cancelValidation();
  };
  const pointerValidation = (event: PointerEvent) => {
    if (touchProbe && event.pointerType !== "touch") cancel();
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
  // xterm starts its asynchronous lookup on the screen before this bubbling
  // listener runs. Expose that pending result without treating it as a valid file.
  let pendingFeedback: object | undefined;
  const showPendingPlain = (event: MouseEvent) => {
    const pending = pathProvider.pendingLinkAt(event);
    if (!pending || event.shiftKey) return;
    const token = {};
    pendingFeedback = token;
    const generation = validationGeneration;
    pendingAnchor = readAnchor(event.clientY);
    menu.loading(
      pending.link.text,
      event.clientX,
      event.clientY,
      instanceKey(event, pending.link.range),
    );
    void pending.ready.then((valid) => {
      if (disposed || generation !== validationGeneration || pendingFeedback !== token) return;
      if (!valid) {
        menu.closeLoading();
        clearTouch();
      }
    });
  };
  const pendingMouseMove = (event: MouseEvent) => {
    if (touchProbe) return;
    if (pathProvider.pendingLinkAt(event)) showPendingPlain(event);
    else if (!unverifiedHover) menu.closeLoading();
  };
  element?.addEventListener("mousemove", pendingMouseMove);
  const mouseMove = (event: MouseEvent) => {
    if (!touchProbes.has(event)) {
      if (touchProbe) cancel();
      suppressHover = false;
    }
    if (
      pendingPlainClick &&
      Math.hypot(event.clientX - pendingPlainClick.x, event.clientY - pendingPlainClick.y) >= 8
    )
      cancelPathValidation();
  };
  element?.addEventListener("mousemove", mouseMove, true);
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
    element?.removeEventListener("mousemove", pendingMouseMove);
    element?.removeEventListener("mousemove", mouseMove, true);
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
    input.dispose();
    checkPaths.dispose();
    paths.dispose();
    menu.dispose();
    links.dispose();
    clipboard?.dispose();
  };
}
