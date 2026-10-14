import { Terminal } from "@xterm/xterm";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { getTerminalSelectionText } from "../../src/lib/terminal/actions";
import { installTerminalBrowserIntegration } from "../../src/lib/terminal/browser-integration";
import { isTerminalTouchMouseEvent } from "../../src/lib/terminal/touch-mouse-events";
import { installTerminalTouchSelection } from "../../src/lib/terminal/touch-selection";

const writes: { text: string; activation: boolean; success: boolean }[] = [];
const clipboard = navigator.clipboard;
const write = clipboard.write.bind(clipboard);
const writeText = clipboard.writeText.bind(clipboard);
clipboard.write = (items) => {
  const activation = navigator.userActivation.isActive;
  return write(items).then(async () => {
    writes.push({
      text: await (await items[0].getType("text/plain")).text(),
      activation,
      success: true,
    });
  });
};
clipboard.writeText = (text) => {
  const activation = navigator.userActivation.isActive;
  return writeText(text).then(() => {
    writes.push({ text, activation, success: true });
  });
};
function element(id: string) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing fixture element: ${id}`);
  return node;
}
createRoot(element("toaster")).render(<Toaster />);
element("seed").onclick = () => {
  void clipboard.writeText("original clipboard");
};
const terms: Terminal[] = [];
const disposers: (() => void)[] = [];
const delayed: { term: Terminal; data: Uint8Array }[] = [];
const gate = { holdClipboard: false };
for (const name of ["first", "second"]) {
  const host = element(name);
  const term = new Terminal({ cols: 32, rows: 10, fontSize: 14, scrollback: 0 });
  term.open(host);
  const socket = new WebSocket(`${location.origin.replace("http", "ws")}/pty?name=${name}`);
  socket.binaryType = "arraybuffer";
  socket.onmessage = (event) => {
    const data = new Uint8Array(event.data);
    if (gate.holdClipboard && new TextDecoder().decode(data).includes("\x1b]52;"))
      delayed.push({ term, data });
    else term.write(data);
  };
  term.onData((data) => socket.send(data));
  const browser = installTerminalBrowserIntegration(term, { allowClipboardWrite: true });
  const selection = installTerminalTouchSelection(host, {
    terminal: () => term,
    enabled: () => host.dataset.terminalTouchSelection === "true",
    onStart: () => {},
    onFinish: () => {},
  });
  // Match the outer InteractiveTerminal guard; generated drags must pass it.
  host.addEventListener(
    "mousedown",
    (event) => {
      if (!event.isTrusted && !isTerminalTouchMouseEvent(event)) event.stopImmediatePropagation();
    },
    true,
  );
  terms.push(term);
  disposers.push(() => {
    selection();
    browser();
    socket.close();
    term.dispose();
  });
}
Object.assign(window, {
  selectionFixture: {
    terms,
    writes,
    disposers,
    delayed,
    gate,
    flushClipboard() {
      for (const item of delayed.splice(0)) item.term.write(item.data);
    },
    selectedText() {
      return getTerminalSelectionText(terms[0]);
    },
  },
});
