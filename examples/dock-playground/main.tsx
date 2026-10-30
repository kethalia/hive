import { Code2, FileText, Folder, Monitor, Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppViewportSize } from "@/components/app-viewport-size";
import {
  type DockAction,
  type DockKeyPress,
  WorkspaceDock,
} from "@/components/experimental/workspace-dock";
import { WorkspaceDockOverlay } from "@/components/experimental/workspace-dock-overlay";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TerminalSessionFrame } from "@/components/workspaces/TerminalSessionFrame";
import { WindowCanvas } from "@/components/workspaces/WindowCanvas";
import { useIsMobile } from "@/hooks/use-mobile";
import { OPEN_GLOBAL_COMMAND_PALETTE_EVENT } from "@/lib/terminal/global-command-palette";
import {
  addGeneralWindow,
  emptyGeneralWorkspace,
  type GeneralBoard,
  type GeneralPane,
  type GeneralWindow,
  type GeneralWorkspaceState,
  hiveToolLabels,
  MAX_GENERAL_BOARDS,
  removeGeneralWindow,
} from "@/lib/workspaces/general-workspace";
import { applyWindowAction, WINDOW_ACTIONS } from "@/lib/workspaces/window-actions";
import {
  newWindowManager,
  reconcileWindowManager,
  revealWindow,
  windowGeometry,
} from "@/lib/workspaces/window-manager";
import { reconcileWorkspaceWindowLayout } from "@/lib/workspaces/workspace-window-layout";
import { SandboxTerminal, type SandboxTerminalController } from "./sandbox-terminal";

const ROOT = document.getElementById("root");
if (!ROOT) throw new Error("Missing playground root");
const TOOLS = [
  { tool: "terminal", label: "Terminal", Icon: Terminal },
  { tool: "files", label: "Files", Icon: Folder },
  { tool: "code", label: "VS Code", Icon: Code2 },
  { tool: "desktop", label: "Desktop", Icon: Monitor },
] as const;
const LAYOUT_ACTIONS = WINDOW_ACTIONS.filter((action) =>
  ["grid", "strip", "cycle-width", "maximize", "float", "equalize"].includes(action.id),
);

function Playground() {
  const [state, setState] = useState(emptyGeneralWorkspace);
  const [panel, setPanel] = useState<"apps" | "keybinds" | "pane" | null>(null);
  const [event, setEvent] = useState("");
  const [fontSize, setFontSize] = useState(13);
  const [clipboard, setClipboard] = useState("hello from the dock");
  const [viewport, setViewport] = useState({ width: 1280, height: 720 });
  const [editorText, setEditorText] = useState(
    "// Local VS Code preview\n\nexport function Hello() {\n  return <h1>Hello, Hive.</h1>;\n}\n",
  );
  const controllers = useRef(new Map<string, SandboxTerminalController>());
  const [, refreshTerminals] = useState(0);
  const upload = useRef<HTMLInputElement>(null);
  const mobile = useIsMobile();
  const board = state.boards.find((item) => item.key === state.activeBoardKey) ?? state.boards[0];
  const active = board.windows.find((item) => item.id === board.activeWindowId);
  const terminal = active?.kind === "terminal" ? controllers.current.get(active.id) : undefined;
  const register = useCallback((id: string, controller: SandboxTerminalController | null) => {
    if (controller) controllers.current.set(id, controller);
    else controllers.current.delete(id);
    refreshTerminals((value) => value + 1);
  }, []);
  const observeBody = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width && entry.contentRect.height)
        setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const open = () => setPanel("apps");
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPanel("apps");
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "/") {
        event.preventDefault();
        setPanel("keybinds");
      }
    };
    window.addEventListener(OPEN_GLOBAL_COMMAND_PALETTE_EVENT, open);
    window.addEventListener("keydown", shortcut);
    return () => {
      window.removeEventListener(OPEN_GLOBAL_COMMAND_PALETTE_EVENT, open);
      window.removeEventListener("keydown", shortcut);
    };
  }, []);

  function update(change: (current: GeneralWorkspaceState) => GeneralWorkspaceState) {
    setState((current) => {
      const next = change(current);
      return {
        ...next,
        boards: next.boards.map((item) => {
          const ids = item.windows.map((window) => window.id);
          const previous = current.boards.find((old) => old.key === item.key);
          let manager = reconcileWindowManager(item.manager, ids, previous?.activeWindowId);
          const layout =
            reconcileWorkspaceWindowLayout(
              item.layout,
              ids.filter((id) => !manager.floating[id]),
              {
                viewportWidth: viewport.width,
                viewportHeight: viewport.height,
                focusedWindowId: item.activeWindowId,
              },
            ) ?? undefined;
          if (
            item.activeWindowId &&
            (item.activeWindowId !== previous?.activeWindowId ||
              item.key !== current.activeBoardKey)
          )
            manager = revealWindow(
              manager,
              windowGeometry(
                manager,
                layout,
                ids,
                item.activeWindowId,
                viewport.width,
                viewport.height,
              ),
              item.activeWindowId,
              viewport.width,
            );
          return { ...item, manager, layout };
        }),
      };
    });
  }
  function changeBoard(key: string, change: (current: GeneralBoard) => GeneralBoard) {
    update((current) => ({
      ...current,
      boards: current.boards.map((item) => (item.key === key ? change(item) : item)),
    }));
  }
  function activate(key: string, id: string) {
    update((current) => ({
      ...current,
      activeBoardKey: key,
      boards: current.boards.map((item) =>
        item.key === key ? { ...item, activeWindowId: id } : item,
      ),
    }));
  }
  function selectBoard(key: string) {
    update((current) => ({ ...current, activeBoardKey: key }));
    setEvent(`Workspace ${state.boards.findIndex((item) => item.key === key) + 1}`);
  }
  function createBoard() {
    if (state.boards.length >= MAX_GENERAL_BOARDS) return;
    const key = crypto.randomUUID();
    update((current) => ({
      ...current,
      activeBoardKey: key,
      boards: [
        ...current.boards,
        {
          key,
          name: `${current.boards.length + 1}`,
          order: current.boards.length,
          windows: [],
          manager: newWindowManager(),
        },
      ],
    }));
    setEvent(`Created workspace ${state.boards.length + 1}`);
  }
  function deleteBoard(key: string) {
    if (state.boards.length < 2) return;
    update((current) => {
      const boards = current.boards.filter((item) => item.key !== key);
      return {
        ...current,
        boards,
        activeBoardKey: current.activeBoardKey === key ? boards[0].key : current.activeBoardKey,
      };
    });
  }
  function openPane(pane: GeneralPane) {
    update((current) => addGeneralWindow(current, pane, crypto.randomUUID()));
    setPanel(null);
    setEvent(`Opened ${pane.label}`);
  }
  function openTool(tool: (typeof TOOLS)[number]["tool"]) {
    openPane(
      tool === "terminal"
        ? {
            kind: "terminal",
            workspaceId: "ai-dev-01",
            sessionName: `terminal-${crypto.randomUUID().slice(0, 8)}`,
            label: "Terminal",
          }
        : {
            kind: "app",
            workspaceId: "ai-dev-01",
            tool,
            label: { files: "Files", code: "VS Code", desktop: "Desktop" }[tool],
          },
    );
  }
  function runAction(action: string) {
    changeBoard(board.key, (current) =>
      applyWindowAction(current, action, viewport.width, viewport.height),
    );
    setEvent(WINDOW_ACTIONS.find((item) => item.id === action)?.label ?? action);
  }
  function pressKey(press: DockKeyPress) {
    if (!terminal) {
      setEvent("Open and focus a terminal to use extra keyboard controls.");
      return;
    }
    terminal.send(press.sequence);
    const { ctrl, alt, shift } = press.modifiers;
    setEvent(
      `${ctrl ? "Ctrl+" : ""}${alt ? "Alt+" : ""}${shift ? "Shift+" : ""}${press.key} · ${JSON.stringify(press.sequence)}`,
    );
  }
  function terminalAction(action: DockAction) {
    if (!terminal) return;
    if (action === "copy") {
      setClipboard(terminal.copy());
      setEvent("Copied terminal selection/output to the preview clipboard.");
    } else if (action === "paste") {
      terminal.send(clipboard);
      setEvent("Pasted from the preview clipboard.");
    } else if (action === "upload") upload.current?.click();
    else {
      const next = Math.max(8, Math.min(28, fontSize + (action === "font-increase" ? 1 : -1)));
      setFontSize(next);
      setEvent(`Terminal font size: ${next}px`);
    }
  }

  function renderPane(pane: GeneralWindow, visible: boolean) {
    if (pane.kind === "terminal")
      return (
        <SandboxTerminal
          id={pane.id}
          register={register}
          onEvent={setEvent}
          fontSize={fontSize}
          visible={visible}
        />
      );
    if (pane.kind === "app" && pane.tool === "files")
      return (
        <div className="p-4 text-sm">
          <p className="mb-4 border-b pb-3 text-muted-foreground">
            /home/coder/projects/kethalia/hive
          </p>
          {["src", "examples", "package.json", "AGENTS.md"].map((name) => (
            <div className="flex items-center gap-3 border-b py-3" key={name}>
              {name.includes(".") ? <FileText className="size-4" /> : <Folder className="size-4" />}
              {name}
            </div>
          ))}
        </div>
      );
    if (pane.kind === "app" && pane.tool === "code")
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-[#1e1e1e] text-zinc-200">
          <div className="border-b border-white/10 p-3 text-xs">scratchpad.tsx · local preview</div>
          <textarea
            aria-label="Scratchpad editor"
            className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-sm outline-none"
            spellCheck={false}
            value={editorText}
            onChange={(event) => setEditorText(event.target.value)}
          />
        </div>
      );
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm">
        <h2>{pane.label}</h2>
        <p className="text-muted-foreground">
          Local preview. Live Coder services are disconnected.
        </p>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <AppViewportSize />
      <div className="h-[var(--app-window-inner-height)] min-h-0 overflow-hidden">
        <main
          id="main-content"
          className="crt-grid crt-scanlines flex h-full min-h-0 flex-1 overflow-hidden"
          data-dashboard-main=""
        >
          <div
            className="flex h-full min-h-0 w-full flex-1 items-stretch gap-0"
            data-dashboard-content-row=""
          >
            <div
              className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
              data-dashboard-content=""
            >
              <section
                className="flex h-full min-h-0 flex-col overflow-hidden"
                data-dashboard-full-bleed=""
                data-testid="general-workspace"
              >
                <div
                  ref={observeBody}
                  className="relative min-h-0 flex-1"
                  data-testid="workspace-canvas"
                >
                  {!board.windows.length ? (
                    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
                      <h1 className="text-lg">Your workspace</h1>
                      <p className="text-sm text-muted-foreground">
                        Bring terminals, Files, VS Code, and Desktop together from any Coder
                        workspace.
                      </p>
                      <Button onClick={() => setPanel("apps")}>Add window</Button>
                    </div>
                  ) : null}
                  <WindowCanvas
                    boards={state.boards}
                    activeBoardKey={board.key}
                    width={viewport.width}
                    height={viewport.height}
                    mobile={mobile}
                    onBoardChange={changeBoard}
                    onActivate={activate}
                    renderPane={(item, pane, visible, _rect, listeners) => (
                      <TerminalSessionFrame
                        label={pane.label}
                        subtitle={pane.kind === "hive" ? "Hive" : "ai-dev-01"}
                        active={pane.id === item.activeWindowId && visible}
                        className="h-full"
                        layoutMode="tiled"
                        dragHandleListeners={listeners}
                        onActivate={() => activate(item.key, pane.id)}
                        onFocusActivate
                        onClose={() =>
                          changeBoard(item.key, (current) => removeGeneralWindow(current, pane.id))
                        }
                        closeLabel={`Close ${pane.label} window`}
                        onCycleWidth={() =>
                          changeBoard(item.key, (current) =>
                            applyWindowAction(
                              { ...current, activeWindowId: pane.id },
                              "cycle-width",
                              viewport.width,
                              viewport.height,
                            ),
                          )
                        }
                        onOpenActions={() => {
                          activate(item.key, pane.id);
                          setPanel("pane");
                        }}
                        touchOptimizedActions={mobile}
                        dataTestId={`preview-window-${pane.id}`}
                      >
                        {renderPane(pane, visible)}
                      </TerminalSessionFrame>
                    )}
                  />
                </div>
                <WorkspaceDockOverlay blocked={panel !== null}>
                  <WorkspaceDock
                    workspaces={state.boards.map((item, index) => ({
                      id: item.key,
                      name: `Workspace ${index + 1}`,
                    }))}
                    activeWorkspaceId={board.key}
                    onWorkspaceSelect={selectBoard}
                    onWorkspaceCreate={createBoard}
                    onWorkspaceRemove={deleteBoard}
                    canCreateWorkspace={state.boards.length < MAX_GENERAL_BOARDS}
                    onAppsOpen={() => setPanel("apps")}
                    onKeybindsOpen={() => setPanel("keybinds")}
                    onKeyPress={pressKey}
                    onAction={terminalAction}
                    disabledActions={
                      terminal
                        ? {
                            "font-decrease":
                              fontSize <= 8 ? "Minimum font size reached" : undefined,
                            "font-increase":
                              fontSize >= 28 ? "Maximum font size reached" : undefined,
                          }
                        : {
                            copy: "Focus a terminal to copy",
                            paste: "Focus a terminal to paste",
                            upload: "Focus a terminal to upload",
                            "font-decrease": "Focus a terminal to change font size",
                            "font-increase": "Focus a terminal to change font size",
                          }
                    }
                  />
                </WorkspaceDockOverlay>
                <span role="status" className="sr-only" data-dock-feedback>
                  {event}
                </span>
              </section>
            </div>
          </div>
        </main>
      </div>
      <CommandDialog
        open={panel === "apps"}
        onOpenChange={(open) => {
          if (!open) setPanel(null);
        }}
        contentClassName="prototype-dialog"
      >
        <CommandInput placeholder="Search Hive…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Open window">
            {TOOLS.map(({ tool, label, Icon }) => (
              <CommandItem key={tool} value={label} onSelect={() => openTool(tool)}>
                <Icon className="mr-2 size-4" />
                {label}
                <span className="ml-auto text-xs text-muted-foreground">ai-dev-01</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Hive">
            {Object.entries(hiveToolLabels).map(([tool, label]) => (
              <CommandItem
                key={tool}
                onSelect={() =>
                  openPane({ kind: "hive", tool: tool as keyof typeof hiveToolLabels, label })
                }
              >
                {label}
                <span className="ml-auto text-xs text-muted-foreground">Preview</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Layout">
            {LAYOUT_ACTIONS.map((action) => (
              <CommandItem
                key={action.id}
                onSelect={() => {
                  runAction(action.id);
                  setPanel(null);
                }}
              >
                {action.label}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
      <Dialog
        open={panel === "keybinds" || panel === "pane"}
        onOpenChange={(open) => {
          if (!open) setPanel(null);
        }}
      >
        <DialogContent className="prototype-dialog max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {panel === "pane" ? `${active?.label ?? "Window"} actions` : "Keyboard Shortcuts"}
            </DialogTitle>
            <DialogDescription>
              {panel === "pane"
                ? "Arrange this window using Hive’s window manager."
                : "Dock controls and Hive layout actions. Terminal sessions run locally."}
            </DialogDescription>
          </DialogHeader>
          {panel === "pane" ? (
            <div className="grid gap-2">
              {LAYOUT_ACTIONS.map((action) => (
                <Button
                  key={action.id}
                  variant="outline"
                  onClick={() => {
                    runAction(action.id);
                    setPanel(null);
                  }}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Tab / Shift+Tab move through controls. Arrow keys, Home, and End navigate the dock.
                Enter/Space activate. Escape returns from an expanded dock. Ctrl/Cmd+K opens Search
                Hive. Ctrl/Cmd+/ opens this help. Alt+Shift+D expands/minimises the dock. Use the
                top-right minus to minimise, or Enter/Space on the single button to expand. Drag the
                grip or collapsed button to a screen edge. On either drag control, arrows move along
                the edge, Shift+Arrow chooses an edge, and Home/End move to corners. Escape cancels
                dragging. Auto-minimise resumes after 2.5 seconds away.
              </p>
              <p className="text-xs text-muted-foreground">
                Extra keyboard modifiers apply to the next key. Copy/Paste use a preview-only
                clipboard. Upload displays local filenames.
              </p>
              <div className="grid gap-2">
                {LAYOUT_ACTIONS.map((action) => (
                  <Button
                    key={action.id}
                    variant="outline"
                    onClick={() => {
                      runAction(action.id);
                      setPanel(null);
                    }}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <input
        ref={upload}
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
    </TooltipProvider>
  );
}

createRoot(ROOT).render(<Playground />);
