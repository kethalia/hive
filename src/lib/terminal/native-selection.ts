import type { Terminal } from "@xterm/xterm";

/** A selection in a sibling pane must not take ownership of this pane's gestures. */
export function hasNativeTerminalSelection(root: Node | null | undefined): boolean {
  const selection = typeof window === "undefined" ? null : window.getSelection();
  return Boolean(
    root &&
      selection &&
      !selection.isCollapsed &&
      root.contains(selection.anchorNode) &&
      root.contains(selection.focusNode),
  );
}

const snapshots = new WeakMap<
  object,
  { text: string; position: string; currentPosition: () => string }
>();

export function clearPreservedTerminalSelection(term: object): void {
  snapshots.delete(term);
}

export function preservedTerminalSelection(term: object): string | undefined {
  const snapshot = snapshots.get(term);
  return snapshot && snapshot.position === snapshot.currentPosition() ? snapshot.text : undefined;
}

/** Read native ranges without triggering xterm selection redraws. */
export function installNativeTerminalSelection(term: Terminal): () => void {
  const element = term.element;
  const positionKey = () => JSON.stringify(term.getSelectionPosition?.());
  let endpoints: [Node, Node] | undefined;
  const clear = () => {
    endpoints = undefined;
    snapshots.delete(term);
  };
  const newGesture = () => {
    // Native selection handles start new touches too; keep their range intact.
    if (hasNativeTerminalSelection(element) && endpoints?.every((node) => node.isConnected)) return;
    const mirrored = snapshots.has(term);
    clear();
    // Touch compatibility mouse events never reach xterm's usual deselection.
    if (mirrored) term.clearSelection();
  };
  const capture = () => {
    if (!element?.closest('[data-terminal-native-selection="true"]')) return;
    if (!hasNativeTerminalSelection(element)) {
      if (endpoints?.every((node) => node.isConnected)) clear();
      return;
    }
    // A redraw can shrink a native range without fully collapsing it. Keep
    // the original buffer range until a new user gesture starts selection.
    if (endpoints?.some((node) => !node.isConnected)) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const rows = element.querySelector(".xterm-rows");
    if (!rows) return;
    const coordinate = (node: Node, offset: number) => {
      const row = Array.from(rows.children).findIndex((child) => child.contains(node));
      if (row < 0) return undefined;
      const prefix = document.createRange();
      prefix.setStart(rows.children[row], 0);
      prefix.setEnd(node, offset);
      const length = prefix.toString().length;
      const y = term.buffer.active.viewportY + row;
      const line = term.buffer.active.getLine(y);
      if (!line) return undefined;
      let consumed = 0;
      let column = 0;
      // DOM text offsets are UTF-16; buffer columns count wide cells separately.
      while (column < term.cols && consumed < length) {
        const cell = line.getCell(column);
        if (!cell) break;
        if (cell.getWidth() === 0) {
          column++;
          continue;
        }
        consumed += (cell.getChars() || " ").length;
        column += cell.getWidth();
      }
      return { x: column, y };
    };
    const start = coordinate(range.startContainer, range.startOffset);
    const end = coordinate(range.endContainer, range.endOffset);
    if (!start || !end) return;
    const length = (end.y - start.y) * term.cols + end.x - start.x;
    if (length <= 0) return;
    // Selecting through xterm redraws every row and destroys the native range.
    // Read the buffer directly, joining soft wraps while retaining hard newlines.
    let text = "";
    for (let y = start.y; y <= end.y; y++) {
      const line = term.buffer.active.getLine(y);
      if (!line) continue;
      if (y > start.y && !line.isWrapped) text += "\n";
      text += line.translateToString(
        true,
        y === start.y ? start.x : 0,
        y === end.y ? end.x : term.cols,
      );
    }
    endpoints = [range.startContainer, range.endContainer];
    snapshots.set(term, { text, position: positionKey(), currentPosition: positionKey });
  };
  const changed = term.onSelectionChange?.(() => {
    const snapshot = snapshots.get(term);
    if (snapshot && snapshot.position !== positionKey()) clear();
  });
  const copy = (event: ClipboardEvent) => {
    const text = preservedTerminalSelection(term);
    if (!text || !event.clipboardData) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  // Run before clipboard-availability listeners read the selection.
  document.addEventListener("selectionchange", capture, true);
  element?.addEventListener("copy", copy, true);
  element?.addEventListener("pointerdown", newGesture, true);
  element?.addEventListener("touchstart", newGesture, { capture: true, passive: true });
  return () => {
    clear();
    changed?.dispose();
    document.removeEventListener("selectionchange", capture, true);
    element?.removeEventListener("copy", copy, true);
    element?.removeEventListener("pointerdown", newGesture, true);
    element?.removeEventListener("touchstart", newGesture, true);
  };
}
