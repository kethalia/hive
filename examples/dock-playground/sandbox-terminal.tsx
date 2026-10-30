import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { loadTerminalFont, TERMINAL_FONT_FAMILY, TERMINAL_THEME } from "@/lib/terminal/config";
import "@/styles/xterm.css";

export interface SandboxTerminalController {
  send: (sequence: string) => void;
  copy: () => string;
  focus: () => void;
}

/** Hive's xterm renderer and theme, with a local shell instead of a Coder connection. */
export function SandboxTerminal({
  id,
  visible,
  fontSize,
  register,
  onEvent,
}: {
  id: string;
  visible: boolean;
  fontSize: number;
  register: (id: string, controller: SandboxTerminalController | null) => void;
  onEvent: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const eventRef = useRef(onEvent);
  eventRef.current = onEvent;
  const initialFontSize = useRef(fontSize);
  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      theme: TERMINAL_THEME,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: initialFontSize.current,
      cursorBlink: true,
      screenReaderMode: true,
      scrollback: 2000,
    });
    const fit = new FitAddon();
    termRef.current = term;
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host.current);
    term.textarea?.setAttribute("aria-label", `Terminal input ${id}`);
    let disposed = false;
    const resize = () => {
      if (!disposed && host.current?.clientWidth && host.current?.clientHeight) fit.fit();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    loadTerminalFont().then(resize);
    resize();
    let line = "",
      cursor = 0,
      historyIndex = 0;
    const history: string[] = [];
    const prompt = () => term.write("\x1b[32m❯\x1b[0m ");
    function redraw() {
      term.write(
        `\r\x1b[2K\x1b[32m❯\x1b[0m ${line}${cursor < line.length ? `\x1b[${line.length - cursor}D` : ""}`,
      );
    }
    function execute() {
      term.write("\r\n");
      const command = line.trim();
      if (command) history.push(command);
      historyIndex = history.length;
      const result =
        command === "help"
          ? "Local preview shell: help, ls, pwd, whoami, echo <text>, clear.\r\nNo commands run on Coder."
          : command === "ls"
            ? "AGENTS.md  examples/  src/  package.json  pnpm-lock.yaml"
            : command === "pwd"
              ? "/home/coder/projects/kethalia/hive"
              : command === "whoami"
                ? "coder"
                : command.startsWith("echo ")
                  ? command.slice(5)
                  : command === "clear" || !command
                    ? ""
                    : `Preview shell: ${command}. Type help for available commands.`;
      if (command === "clear") term.clear();
      if (result) term.writeln(result);
      eventRef.current(`Terminal · ${command || "Enter"}`);
      line = "";
      cursor = 0;
      prompt();
    }
    function send(data: string) {
      if (data === "\r") {
        execute();
        return;
      }
      if (data === "\x03") {
        term.writeln("^C");
        line = "";
        cursor = 0;
        prompt();
        return;
      }
      if (data === "\x0c") {
        term.clear();
        redraw();
        return;
      }
      if (data === "\x1b") {
        line = "";
        cursor = 0;
        redraw();
        return;
      }
      if (data === "\x7f") {
        if (cursor > 0) {
          line = line.slice(0, cursor - 1) + line.slice(cursor);
          cursor--;
          redraw();
        }
        return;
      }
      if (data === "\x1b[D" || data === "\x1b[C") {
        cursor = Math.max(0, Math.min(line.length, cursor + (data.endsWith("D") ? -1 : 1)));
        redraw();
        return;
      }
      if (data === "\x1b[A" || data === "\x1b[B") {
        historyIndex = Math.max(
          0,
          Math.min(history.length, historyIndex + (data.endsWith("A") ? -1 : 1)),
        );
        line = history[historyIndex] ?? "";
        cursor = line.length;
        redraw();
        return;
      }
      if (
        data.startsWith("\x1b") ||
        Array.from(data).some((character) => {
          const code = character.charCodeAt(0);
          return code < 9 || (code > 10 && code < 32 && code !== 13);
        })
      )
        return;
      const text = data.replace(/\t/g, "  ").replace(/[\r\n]/g, " ");
      line = line.slice(0, cursor) + text + line.slice(cursor);
      cursor += text.length;
      redraw();
    }
    const listener = term.onData(send);
    term.writeln("\x1b[32mcoder\x1b[0m ~/projects/kethalia/hive");
    term.writeln("Local terminal preview. Type help to explore.\r\n");
    prompt();
    register(id, {
      send,
      focus: () => term.focus(),
      copy: () =>
        term.getSelection() ||
        Array.from(
          { length: term.buffer.active.length },
          (_, index) => term.buffer.active.getLine(index)?.translateToString(true) ?? "",
        )
          .join("\n")
          .trim(),
    });
    return () => {
      disposed = true;
      observer.disconnect();
      listener.dispose();
      register(id, null);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [id, register]);
  useEffect(() => {
    if (termRef.current) termRef.current.options.fontSize = fontSize;
    if (visible && host.current?.clientWidth && host.current?.clientHeight) fitRef.current?.fit();
  }, [fontSize, visible]);
  return (
    <div
      ref={host}
      className="sandbox-terminal"
      data-terminal-surface="true"
      data-mobile-scroll-allow="true"
      data-sandbox-terminal={id}
    />
  );
}
