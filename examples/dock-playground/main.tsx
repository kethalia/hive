import {
  ArrowDown,
  ArrowUpRight,
  Check,
  Code2,
  FileText,
  Folder,
  Globe,
  Hexagon,
  Layers,
  Monitor,
  Moon,
  RotateCcw,
  Smartphone,
  Sparkles,
  Sun,
  Terminal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  type DockAction,
  type DockKeyPress,
  type DockWorkspace,
  WorkspaceDock,
} from "@/components/experimental/workspace-dock";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { encodeTerminalShortcut } from "@/lib/terminal/shortcut-keys";

const INITIAL_WORKSPACES: DockWorkspace[] = [
  { id: "workspace-1", name: "Main workspace" },
  { id: "workspace-2", name: "Side project" },
  { id: "workspace-3", name: "Experiments" },
];
const APPS = [
  { name: "Terminal", Icon: Terminal, color: "mint", description: "A place to make things" },
  { name: "Files", Icon: Folder, color: "blue", description: "Everything in its place" },
  { name: "Browser", Icon: Globe, color: "purple", description: "A window to the web" },
  { name: "Editor", Icon: Code2, color: "peach", description: "Your next good idea" },
];
interface Session {
  input: string;
  lines: string[];
}
const freshSession = (): Session => ({
  input: "",
  lines: ["Welcome to your dock playground.", "Try the dock below, or type help and press Enter."],
});
const ROOT = document.getElementById("root");
if (!ROOT) throw new Error("Missing playground root");

function Playground() {
  const [workspaces, setWorkspaces] = useState(INITIAL_WORKSPACES);
  const [activeId, setActiveId] = useState("workspace-1");
  const [sessions, setSessions] = useState<Record<string, Session>>({
    "workspace-1": freshSession(),
  });
  const [panel, setPanel] = useState<"apps" | "keybinds" | null>(null);
  const [app, setApp] = useState("Terminal");
  const [theme, setTheme] = useState("dark");
  const [wallpaper, setWallpaper] = useState("dusk");
  const [mobile, setMobile] = useState(false);
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const [event, setEvent] = useState("Your dock is ready. Make yourself at home.");
  const [fontSize, setFontSize] = useState(13);
  const [clipboard, setClipboard] = useState("hello from the dock");
  const [dockVersion, setDockVersion] = useState(0);
  const terminalRef = useRef<HTMLTextAreaElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const session = sessions[activeId] ?? freshSession();
  const workspace = workspaces.find((item) => item.id === activeId);
  const index = workspaces.findIndex((item) => item.id === activeId) + 1;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  function updateSession(change: (current: Session) => Session) {
    setSessions((current) => ({
      ...current,
      [activeId]: change(current[activeId] ?? freshSession()),
    }));
  }
  function createWorkspace() {
    const number = workspaces.length + 1;
    const next = { id: `workspace-${number}`, name: `Workspace ${number}` };
    setWorkspaces((current) => [...current, next]);
    setActiveId(next.id);
    setEvent(`Created workspace ${number}. A fresh canvas.`);
  }
  function selectWorkspace(id: string) {
    setActiveId(id);
    setEvent(`Switched to ${workspaces.find((item) => item.id === id)?.name ?? id}.`);
  }
  function execute(input: string) {
    const command = input.trim();
    if (command === "clear") {
      updateSession(() => ({ input: "", lines: [] }));
      return;
    }
    const response =
      command === "help"
        ? "Try: help, ls, pwd, whoami, echo <text>, clear. No commands run on a server."
        : command === "ls"
          ? "src/    components/    ideas/    README.md"
          : command === "pwd"
            ? `/hive/workspace-${index}`
            : command === "whoami"
              ? "you, in your element."
              : command.startsWith("echo ")
                ? command.slice(5)
                : command
                  ? `“${command}” received. This is a simulated terminal; try help.`
                  : "";
    updateSession((current) => ({
      input: "",
      lines: [...current.lines, `❯ ${input}`, ...(response ? [response] : [])].slice(-40),
    }));
    setEvent(`Workspace ${index} · Enter`);
  }
  function pressKey(press: DockKeyPress) {
    const { key, sequence, modifiers } = press;
    const prefix = `${modifiers.ctrl ? "Ctrl+" : ""}${modifiers.alt ? "Alt+" : ""}${modifiers.shift ? "Shift+" : ""}`;
    setEvent(`Workspace ${index} · ${prefix}${key} · ${JSON.stringify(sequence)}`);
    if (modifiers.ctrl || modifiers.alt) return;
    if (key === "Enter") {
      execute(session.input);
      return;
    }
    if (key === "Esc") {
      updateSession((current) => ({ ...current, input: "" }));
      return;
    }
    const input = terminalRef.current;
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (key === "Left" || key === "Right") {
      input.setSelectionRange(
        Math.max(0, start + (key === "Left" ? -1 : 1)),
        Math.max(0, start + (key === "Left" ? -1 : 1)),
      );
      return;
    }
    if (key === "Up" || key === "Down") return;
    const insert = key === "Space" ? " " : key === "Tab" ? "  " : "";
    const deleteStart = key === "Backspace" && start === end ? Math.max(0, start - 1) : start;
    updateSession((current) => ({
      ...current,
      input: current.input.slice(0, deleteStart) + insert + current.input.slice(end),
    }));
    requestAnimationFrame(() =>
      input.setSelectionRange(deleteStart + insert.length, deleteStart + insert.length),
    );
  }
  function action(id: DockAction) {
    if (id === "copy") {
      const input = terminalRef.current;
      const selected = input ? session.input.slice(input.selectionStart, input.selectionEnd) : "";
      const text = selected || session.input || session.lines.join("\n");
      setClipboard(text);
      setEvent("Copied to the playground clipboard. Open Paste to try it.");
    } else if (id === "paste") {
      updateSession((current) => ({ ...current, input: current.input + clipboard }));
      setEvent("Pasted from the playground clipboard.");
    } else if (id === "upload") uploadRef.current?.click();
    else {
      const size = Math.max(11, Math.min(20, fontSize + (id === "font-increase" ? 1 : -1)));
      setFontSize(size);
      setEvent(`Terminal font size: ${size}px`);
    }
  }
  function reset() {
    setWorkspaces(INITIAL_WORKSPACES);
    setActiveId("workspace-1");
    setSessions({ "workspace-1": freshSession() });
    setApp("Terminal");
    setFontSize(13);
    setClipboard("hello from the dock");
    setDockVersion((current) => current + 1);
    setEvent("Fresh start. Your playground has been reset.");
  }

  return (
    <div className="playground">
      <header className="site-header">
        <a className="wordmark" href="#">
          <Hexagon aria-hidden="true" />
          <span>
            hive<span className="wordmark-dot">.</span>
          </span>
          <span className="header-divider" />
          <span className="header-label">the lab</span>
        </a>
        <div className="header-actions">
          <span className="prototype-tag">
            <span />
            Component experiment 001
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="round-button"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>
        </div>
      </header>
      <main>
        <section className="intro">
          <div>
            <p className="eyebrow">
              <span /> A SMALLER INTERFACE. A BIGGER WORKSPACE.
            </p>
            <h1>
              Everything, <span>within reach.</span>
            </h1>
            <p className="intro-copy">
              A familiar little dock for your next big idea.
              <br />
              Apps, workspaces, and your favorite keys. All in one place.
            </p>
          </div>
          <a href="#playground" className="try-link">
            Take it for a spin <ArrowDown aria-hidden="true" />
          </a>
        </section>
        <section className="experiment" id="playground" aria-label="Interactive dock playground">
          <div className="experiment-bar">
            <div className="experiment-title">
              <Sparkles aria-hidden="true" />
              <span>Dock playground</span>
              <span className="preview-tag">LIVE PREVIEW</span>
            </div>
            <div className="preview-controls">
              <fieldset className="segmented" aria-label="Preview width">
                <Button
                  variant="ghost"
                  aria-label="Desktop preview"
                  aria-pressed={!mobile}
                  onClick={() => setMobile(false)}
                >
                  <Monitor />
                </Button>
                <Button
                  variant="ghost"
                  aria-label="Mobile preview"
                  aria-pressed={mobile}
                  onClick={() => setMobile(true)}
                >
                  <Smartphone />
                </Button>
              </fieldset>
              <span className="bar-divider" />
              <Button variant="ghost" className="reset-button" onClick={reset}>
                <RotateCcw />
                Reset
              </Button>
            </div>
          </div>
          <div className="preview-surround">
            <div className={`desktop-scene wallpaper-${wallpaper} ${mobile ? "mobile-scene" : ""}`}>
              <div className="scene-topline">
                <span>
                  <span className="scene-status" />
                  {workspace?.name}
                </span>
                <span>Workspace {String(index).padStart(2, "0")}</span>
              </div>
              <div className="terminal-window">
                <div className="terminal-titlebar">
                  <span className="traffic-lights">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>
                    <Terminal size={12} />
                    {app.toLowerCase()} — workspace {index}
                  </span>
                  <span className="terminal-shell">zsh</span>
                </div>
                <div className="terminal-body" style={{ fontSize }}>
                  {app === "Terminal" ? (
                    <>
                      <p className="terminal-welcome">
                        <span>✳</span> A little room to build.
                      </p>
                      <section className="terminal-output" aria-label="Simulated terminal output">
                        <pre>{session.lines.join("\n")}</pre>
                      </section>
                      <label className="terminal-input-row">
                        <span>❯</span>
                        <textarea
                          ref={terminalRef}
                          rows={1}
                          aria-label="Simulated terminal input"
                          value={session.input}
                          spellCheck={false}
                          onChange={(event) =>
                            updateSession((current) => ({ ...current, input: event.target.value }))
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              execute(session.input);
                            }
                          }}
                          placeholder="Type help to explore…"
                        />
                      </label>
                    </>
                  ) : app === "Files" ? (
                    <>
                      <p className="terminal-welcome">Your files, at a glance.</p>
                      <div className="file-grid">
                        {["src", "components", "ideas", "README.md"].map((name) => (
                          <div key={name}>
                            {name.endsWith("md") ? <FileText /> : <Folder />}
                            <span>{name}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : app === "Browser" ? (
                    <div className="app-placeholder">
                      <Globe />
                      <h2>A window to your workspace.</h2>
                      <p>Browser app preview · workspace {index}</p>
                    </div>
                  ) : (
                    <label className="editor-label">
                      scratchpad.tsx
                      <textarea
                        aria-label="Scratchpad editor"
                        defaultValue={
                          "// Something good starts here.\n\nexport function Hello() {\n  return <h1>Hello, Hive.</h1>;\n}"
                        }
                        spellCheck={false}
                      />
                    </label>
                  )}
                </div>
                <div className="terminal-footer">
                  <span>
                    <span />
                    sandbox session
                  </span>
                  <span>{app === "Terminal" ? "Try “help” ↵" : "App preview"}</span>
                </div>
              </div>
              <div className="dock-anchor">
                <WorkspaceDock
                  key={dockVersion}
                  density={density}
                  workspaces={workspaces}
                  activeWorkspaceId={activeId}
                  onWorkspaceSelect={selectWorkspace}
                  onWorkspaceCreate={createWorkspace}
                  canCreateWorkspace={workspaces.length < 24}
                  onAppsOpen={() => setPanel("apps")}
                  onKeybindsOpen={() => setPanel("keybinds")}
                  onKeyPress={pressKey}
                  onAction={action}
                  disabledActions={{
                    "font-decrease": fontSize <= 11 ? "Minimum font size reached" : undefined,
                    "font-increase": fontSize >= 20 ? "Maximum font size reached" : undefined,
                  }}
                />
              </div>
              <p className="scene-hint">Your tools. A click away.</p>
            </div>
          </div>
          <div className="playground-settings">
            <div className="wallpaper-control">
              <span>Backdrop</span>
              {["dusk", "moss", "sand"].map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`wallpaper-swatch swatch-${name}`}
                  aria-label={`${name} backdrop`}
                  aria-pressed={wallpaper === name}
                  onClick={() => setWallpaper(name)}
                >
                  {wallpaper === name ? <Check size={12} /> : null}
                </button>
              ))}
            </div>
            <label className="density-control">
              Dock size
              <select
                aria-label="Dock size"
                value={density}
                onChange={(event) => setDensity(event.target.value as typeof density)}
              >
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </select>
            </label>
          </div>
          <div className="activity" role="status">
            <span className="activity-dot" />
            <span>{event}</span>
            <span className="activity-label">INTERACTION LOG</span>
          </div>
        </section>
        <section className="details" aria-label="Things to try">
          <article>
            <span className="detail-number">01</span>
            <div>
              <h2>One dock. Four ways in.</h2>
              <p>Open an app, jump between workspaces, pull up extra keys, or find a keybind.</p>
            </div>
            <Grid2X2Icon />
          </article>
          <article>
            <span className="detail-number">02</span>
            <div>
              <h2>Space when you need it.</h2>
              <p>Workspaces and keyboard controls expand in place. Back brings you home.</p>
            </div>
            <Layers />
          </article>
          <article>
            <span className="detail-number">03</span>
            <div>
              <h2>Small screen. Same toolkit.</h2>
              <p>Every key lives on desktop, too. On mobile, swipe the dock to reach them all.</p>
            </div>
            <Smartphone />
          </article>
        </section>
      </main>
      <footer className="site-footer">
        <span>
          <Hexagon size={14} /> Made for a quieter workspace.
        </span>
        <span>
          Prototype only · not connected to your Hive account <ArrowUpRight size={13} />
        </span>
      </footer>
      <input
        ref={uploadRef}
        type="file"
        multiple
        hidden
        aria-label="Playground file upload"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length)
            setEvent(
              `Upload preview: ${files.map((file) => file.name).join(", ")} · files stay on your device`,
            );
          event.target.value = "";
        }}
      />
      <Dialog
        open={panel !== null}
        onOpenChange={(open) => {
          if (!open) setPanel(null);
        }}
      >
        <DialogContent className="playground-dialog">
          <DialogHeader>
            <p className="eyebrow">{panel === "apps" ? "YOUR TOOLKIT" : "AT YOUR FINGERTIPS"}</p>
            <DialogTitle>
              {panel === "apps" ? "A place for every tool." : "A few helpful keybinds."}
            </DialogTitle>
            <DialogDescription>
              {panel === "apps"
                ? "Choose an app to try in this workspace."
                : "The dock works with Tab, arrow keys, Home, End, Enter, and Space. Escape returns to the main dock when it has focus."}
            </DialogDescription>
          </DialogHeader>
          {panel === "apps" ? (
            <div className="app-grid">
              {APPS.map(({ name, Icon, color, description }) => (
                <Button
                  key={name}
                  variant="ghost"
                  className="app-tile"
                  onClick={() => {
                    setApp(name);
                    setPanel(null);
                    setEvent(`Opened ${name} in workspace ${index}.`);
                  }}
                >
                  <span className={`app-tile-icon icon-${color}`}>
                    <Icon />
                  </span>
                  <strong>{name}</strong>
                  <span>{description}</span>
                </Button>
              ))}
            </div>
          ) : (
            <div className="keybind-list">
              {[
                ["Move through controls", "Tab / Shift Tab"],
                ["Previous / next dock item", "← / →"],
                ["First / last dock item", "Home / End"],
                ["Activate a control", "Enter / Space"],
                ["Return / close dialog", "Esc"],
              ].map(([label, key]) => (
                <div key={label}>
                  <span>{label}</span>
                  <kbd>{key}</kbd>
                </div>
              ))}
              <p>
                Extra keyboard modifiers are one-shot: toggle Ctrl, Alt, or Shift, then press a key.
                Combinations appear in the interaction log. Clipboard and uploads are simulated
                locally.
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  setPanel(null);
                  setApp("Terminal");
                  setEvent(
                    `Keybind example · Ctrl+Up · ${JSON.stringify(encodeTerminalShortcut("Up", { ctrl: true, alt: false, shift: false }))}`,
                  );
                }}
              >
                Try a Ctrl + ↑ example
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Grid2X2Icon() {
  return (
    <span className="tiny-grid" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
createRoot(ROOT).render(<Playground />);
