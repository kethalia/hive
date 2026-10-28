import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { AppViewportSize } from "@/components/app-viewport-size";
import { DashboardKeyboardController } from "@/components/dashboard-keyboard-controller";
import { HelpOverlay } from "@/components/terminal/HelpOverlay";
import { KeybindingProvider } from "@/components/terminal/KeybindingProvider";
import { Toaster } from "@/components/ui/sonner";
import { GeneralWorkspace } from "@/components/workspaces/GeneralWorkspace";
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
  const host = useRef<HTMLDivElement>(null);
  const useXterm = new URLSearchParams(location.search).has("xterm");
  const callbacks = useRef({ onTerminalReady, onTerminalDestroy });
  callbacks.current = { onTerminalReady, onTerminalDestroy };
  useEffect(() => {
    window.fixture.mounts[sessionName] = (window.fixture.mounts[sessionName] ?? 0) + 1;
    const terminal = useXterm && host.current ? new Terminal({ rows: 24, cols: 40 }) : null;
    if (terminal && host.current) {
      terminal.open(host.current);
      terminal.write(
        Array.from({ length: 80 }, (_, index) => `${sessionName} line ${index}\r\n`).join(""),
      );
    }
    callbacks.current.onTerminalReady(
      terminal ??
        ({
          focus: () => input.current?.focus(),
          element: input.current?.parentElement,
          hasSelection: () => false,
          onSelectionChange: () => ({ dispose() {} }),
        } as unknown as Terminal),
      () => {},
    );
    return () => {
      window.fixture.destroys[sessionName] = (window.fixture.destroys[sessionName] ?? 0) + 1;
      callbacks.current.onTerminalDestroy();
      terminal?.dispose();
    };
  }, [sessionName, useXterm]);
  return (
    <div className="flex h-full flex-col p-4 font-mono text-sm">
      <p className="shrink-0 truncate text-primary">{sessionName} · connected</p>
      <p className="mt-2 shrink-0 truncate text-muted-foreground">
        A persistent terminal pane. Resize, move, and switch layouts without reconnecting.
      </p>
      {useXterm ? (
        <div ref={host} className="min-h-0 flex-1 overflow-hidden" />
      ) : (
        <textarea
          ref={input}
          aria-label={`${sessionName} input`}
          className="xterm-helper-textarea mt-2 min-h-0 flex-1 resize-none bg-black outline-none"
          onFocus={onUserFocusRequest}
          defaultValue={`$ ${sessionName}\n`}
        />
      )}
    </div>
  );
}
export const fixtureWorkspaces = [
  {
    id: "software",
    name: "ai-dev-01",
    template_name: "ai-dev-k8s",
    latest_build: { id: "build-1", status: "running" },
  },
  {
    id: "browser",
    name: "browser-helper",
    template_name: "browser-testing",
    latest_build: { id: "build-2", status: "running" },
  },
  {
    id: "infra",
    name: "infrastructure-helper",
    template_name: "infrastructure",
    latest_build: { id: "build-3", status: "stopped" },
  },
];
export const fixtureTemplates = [
  "ai-dev-k8s",
  "browser-testing",
  "game-dev",
  "electronics",
  "infrastructure",
].map((name) => ({
  name,
  stale: false,
  lastPushed: null,
  activeVersionId: null,
  localHash: "fixture",
  remoteHash: null,
}));
export const fixtureAgents = {
  checkedAt: 1790000000,
  profile: "software",
  coderMcpSupported: true,
  typescriptServerInstalled: true,
  agents: ["codex", "claude"].map((agent) => ({
    agent,
    installed: true,
    version: "1.2.3",
    auth: "signed-in",
    tracking: true,
    connections: [{ name: "hive_coder", enabled: true }],
    plugins: [{ name: "a-long-plugin-name@openai-curated-remote", enabled: true }],
    warnings: [],
  })),
  sessions: [
    {
      key: "codex-test",
      id: "test",
      agent: "codex",
      project: "hive",
      directory: "projects/kethalia/hive",
      updatedAt: 1790000000,
      state: "working",
      running: true,
      directoryExists: true,
    },
  ],
};
const storage = generalWorkspaceStorageKey("fixture");
if (!localStorage.getItem(storage)) {
  const state = emptyGeneralWorkspace();
  state.boards[0].manager = {
    mode: "grid",
    columns: [],
    floating: {},
    scroll: 0,
    shortcuts: "primary+alt",
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
    <QueryClientProvider client={new QueryClient()}>
      <KeybindingProvider>
        <AppViewportSize />
        <Toaster />
        <HelpOverlay />
        <div className="h-dvh w-full overflow-hidden">
          <div>
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
                  <GeneralWorkspace
                    userId="fixture"
                    initialWorkspaces={fixtureWorkspaces as never}
                  />
                  <DashboardKeyboardController />
                </>
              )}
            </main>
          </div>
        </div>
      </KeybindingProvider>
    </QueryClientProvider>,
  );
