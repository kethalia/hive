import type { IClipboardProvider } from "@xterm/addon-clipboard";
import type { Terminal } from "@xterm/xterm";
import { toast } from "sonner";
import { observeTerminalActivity } from "./activity";
import { isTerminalSelectionSurface } from "./selection-surface";

const controllers = new WeakMap<Terminal, ReturnType<typeof createSelectionClipboard>>();
let nextId = 0;

/** One response from this terminal, following a deliberate selection release. */
export function createSelectionClipboard(available: () => boolean = () => true) {
  const id = `terminal-clipboard-copy-${++nextId}`;
  let disposed = false;
  let dragging = false;
  let pending:
    | { resolve: (text: Blob) => void; reject: () => void; timer: ReturnType<typeof setTimeout> }
    | undefined;
  const offerCopy = (text: string) => {
    if (disposed || !available()) return;
    toast("Terminal text is ready to copy", {
      id,
      duration: 15000,
      action: {
        label: "Copy",
        onClick: async () => {
          if (disposed || !available()) return;
          try {
            await navigator.clipboard.writeText(text);
            if (!disposed) toast.success("Copied terminal text");
          } catch {
            if (!disposed) toast.error("Clipboard access was denied");
          }
        },
      },
    });
  };
  const cancel = () => {
    dragging = false;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reject();
    pending = undefined;
  };
  const release = () => {
    if (disposed || !available() || !dragging) return cancel();
    cancel();
    let resolve!: (text: Blob) => void;
    let reject!: () => void;
    const content = new Promise<Blob>((yes, no) => {
      resolve = yes;
      reject = () => no(new Error("Terminal selection cancelled"));
    });
    // A browser may reject write before it consumes the deferred item.
    void content.catch(() => {});
    const request = { resolve, reject, timer: setTimeout(cancel, 3000) };
    pending = request;
    // Reserve the write during mouseup/touchend. tmux's OSC 52 reply arrives
    // asynchronously, after the browser's transient user activation has ended.
    let writing: Promise<void> | undefined;
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        writing = navigator.clipboard.write([new ClipboardItem({ "text/plain": content })]);
        void writing.catch(() => {});
      }
    } catch {
      /* Offer a fresh Copy gesture when the text arrives. */
    }
    void content.then(
      async (blob) => {
        const text = await blob.text();
        if (disposed || !available()) return;
        try {
          if (writing) await writing;
          else await navigator.clipboard.writeText(text);
          if (!disposed) toast.success("Copied terminal text");
        } catch {
          offerCopy(text);
        }
      },
      () => {},
    );
  };
  const provider: IClipboardProvider = {
    readText: () => "",
    writeText: (_selection, text) => {
      if (disposed || !text || text.length > 1024 * 1024) return;
      if (!available()) return cancel();
      if (pending) {
        const request = pending;
        pending = undefined;
        clearTimeout(request.timer);
        request.resolve(new Blob([text], { type: "text/plain" }));
      } else if (!dragging) offerCopy(text);
    },
  };
  return {
    provider,
    begin() {
      cancel();
      dragging = !disposed && available();
    },
    release,
    cancel,
    dispose() {
      disposed = true;
      cancel();
      toast.dismiss(id);
    },
  };
}

export function terminalSelectionClipboard(term: Terminal) {
  return controllers.get(term);
}

export function installSelectionClipboard(term: Terminal) {
  let activity: ReturnType<typeof observeTerminalActivity> | undefined;
  const clipboard = createSelectionClipboard(() => {
    activity?.flush();
    return Boolean(
      term.element?.isConnected && !term.element.closest("[inert]") && !document.hidden,
    );
  });
  controllers.set(term, clipboard);
  let start: { x: number; y: number; moved: boolean } | undefined;
  const down = (event: MouseEvent) => {
    if (
      !event.isTrusted ||
      event.button !== 0 ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !isTerminalSelectionSurface(
        term.element?.querySelector<HTMLElement>(".xterm-screen"),
        event.target,
        event,
      ) ||
      !term.modes ||
      term.modes.mouseTrackingMode === "none"
    )
      return;
    clipboard.begin();
    start = { x: event.clientX, y: event.clientY, moved: false };
  };
  const move = (event: MouseEvent) => {
    if (
      start &&
      event.isTrusted &&
      (!(event.buttons & 1) ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        term.modes.mouseTrackingMode === "none")
    )
      return cancel();
    if (
      start &&
      event.isTrusted &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 8
    )
      start.moved = true;
  };
  const up = (event: MouseEvent) => {
    if (!start || !event.isTrusted || event.button !== 0) return;
    const moved = start.moved;
    start = undefined;
    if (
      moved &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      term.modes.mouseTrackingMode !== "none" &&
      !term.options.disableStdin &&
      !term.element?.closest("[inert]")
    )
      clipboard.release();
    else clipboard.cancel();
  };
  const cancel = () => {
    start = undefined;
    clipboard.cancel();
  };
  const visibility = () => {
    if (document.hidden) cancel();
  };
  if (term.element) activity = observeTerminalActivity(term.element, cancel);
  term.element?.addEventListener("mousedown", down);
  document.addEventListener("pointerdown", cancel, true);
  document.addEventListener("mousemove", move, true);
  document.addEventListener("mouseup", up, true);
  window.addEventListener("blur", cancel);
  window.addEventListener("resize", cancel);
  document.addEventListener("visibilitychange", visibility);
  return {
    provider: clipboard.provider,
    dispose() {
      activity?.dispose();
      cancel();
      clipboard.dispose();
      controllers.delete(term);
      term.element?.removeEventListener("mousedown", down);
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", up, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
      document.removeEventListener("visibilitychange", visibility);
    },
  };
}
