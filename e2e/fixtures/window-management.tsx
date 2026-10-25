import type { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CommandPalette } from "@/components/terminal/CommandPalette";
import { KeybindingProvider } from "@/components/terminal/KeybindingProvider";
import { SidebarProvider } from "@/components/ui/sidebar";
import { GeneralWorkspace } from "@/components/workspaces/GeneralWorkspace";
import { useRegisterKeybinding } from "@/hooks/useKeybindings";
import {
  getGlobalCommandPaletteSources,
  OPEN_GLOBAL_COMMAND_PALETTE_EVENT,
} from "@/lib/terminal/global-command-palette";
import {
  emptyGeneralWorkspace,
  generalWorkspaceStorageKey,
} from "@/lib/workspaces/general-workspace";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../src/components/ui/collapsible";

declare global {
  interface Window {
    fixture: {
      mounts: Record<string, number>;
      destroys: Record<string, number>;
      appRequests: number;
    };
  }
}
window.fixture ??= { mounts: {}, destroys: {}, appRequests: 0 };
export function FixtureTerminal({
  sessionName,
  onTerminalReady,
  onTerminalDestroy,
  onUserFocusRequest,
}: {
  sessionName: string;
  onTerminalReady: (term: Terminal, send: (data: string) => void) => void;
  onTerminalDestroy: () => void;
  onUserFocusRequest: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const callbacks = useRef({ onTerminalReady, onTerminalDestroy });
  callbacks.current = { onTerminalReady, onTerminalDestroy };
  useEffect(() => {
    window.fixture.mounts[sessionName] = (window.fixture.mounts[sessionName] ?? 0) + 1;
    callbacks.current.onTerminalReady(
      {
        focus: () => input.current?.focus(),
        element: input.current?.parentElement,
        hasSelection: () => false,
        onSelectionChange: () => ({ dispose() {} }),
      } as unknown as Terminal,
      () => {},
    );
    return () => {
      window.fixture.destroys[sessionName] = (window.fixture.destroys[sessionName] ?? 0) + 1;
      callbacks.current.onTerminalDestroy();
    };
  }, [sessionName]);
  return (
    <div className="flex h-full flex-col p-4 font-mono text-sm">
      <p className="text-primary">{sessionName} · connected</p>
      <p className="mt-3 text-muted-foreground">
        A persistent terminal pane. Resize, move, and switch layouts without reconnecting.
      </p>
      <textarea
        ref={input}
        aria-label={`${sessionName} input`}
        className="xterm-helper-textarea mt-4 min-h-0 flex-1 resize-none bg-black outline-none"
        onFocus={onUserFocusRequest}
        defaultValue={`$ ${sessionName}\n`}
      />
    </div>
  );
}
function Palette() {
  const [open, setOpen] = useState(false);
  useRegisterKeybinding({
    id: "fixture:search",
    keys: ["ctrl+k", "cmd+k"],
    description: "Search",
    category: "navigation",
    enabledInBrowser: true,
    global: true,
    action: () => {
      setOpen(true);
      return false;
    },
  });
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener(OPEN_GLOBAL_COMMAND_PALETTE_EVENT, handler);
    return () => window.removeEventListener(OPEN_GLOBAL_COMMAND_PALETTE_EVENT, handler);
  }, []);
  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      tabs={[]}
      onSelectTab={() => {}}
      actions={getGlobalCommandPaletteSources().flatMap((s) => s.actions ?? [])}
    />
  );
}
export const fixtureWorkspaces = [
  {
    id: "software",
    name: "ai-dev-01",
    template_name: "ai-dev-k8s",
    latest_build: { id: "build-1", status: "running" },
  },
];
const storage = generalWorkspaceStorageKey("fixture");
if (!localStorage.getItem(storage)) {
  const state = emptyGeneralWorkspace();
  state.boards[0].manager = {
    mode: "grid",
    columns: [],
    floating: {},
    scroll: 0,
    shortcuts: "ctrl+alt",
  };
  state.boards[0].windows = [
    ...["codex", "claude"].map((id) => ({
      id,
      workspaceId: "software",
      kind: "terminal" as const,
      sessionName: id,
      label: id,
    })),
    { id: "files", workspaceId: "software", kind: "app", tool: "files", label: "Files" },
  ];
  state.boards[0].activeWindowId = "codex";
  localStorage.setItem(storage, JSON.stringify(state));
}
const root = document.getElementById("app");
if (root)
  createRoot(root).render(
    <KeybindingProvider>
      <SidebarProvider>
        <main className="h-dvh w-full bg-background text-foreground">
          {new URLSearchParams(location.search).has("collapsible") ? (
            <Collapsible className="w-64 m-4">
              <CollapsibleTrigger>Workspace apps</CollapsibleTrigger>
              <CollapsibleContent>
                <p className="p-4">Files</p>
                <p className="p-4">VS Code</p>
              </CollapsibleContent>
            </Collapsible>
          ) : (
            <>
              <GeneralWorkspace userId="fixture" initialWorkspaces={fixtureWorkspaces as never} />
              <Palette />
            </>
          )}
        </main>
      </SidebarProvider>
    </KeybindingProvider>,
  );
