import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PersistentTerminal,
  PersistentTerminalProvider,
} from "../../src/components/terminal/PersistentTerminalProvider";
import type { InteractiveTerminalProps } from "../../src/components/workspaces/InteractiveTerminal";
import { useTerminalWebSocket } from "../../src/hooks/useTerminalWebSocket";

// A minimal surface around the production session host and transport. This
// harness is bundled by Playwright and is never exposed by the Next.js app.
function Runtime({ workspaceId }: InteractiveTerminalProps) {
  const [output, setOutput] = useState("");
  const { connectionState, send } = useTerminalWebSocket({
    url: `ws://${location.host}/socket?workspace=${workspaceId}`,
    onData: (data) =>
      setOutput(
        (value) => value + (typeof data === "string" ? data : new TextDecoder().decode(data)),
      ),
  });
  return (
    <section data-testid={`terminal-${workspaceId}`} data-state={connectionState}>
      <textarea
        aria-label={`Input ${workspaceId}`}
        onKeyDown={(event) => {
          if (event.key.length === 1) send(JSON.stringify({ data: event.key }));
        }}
      />
      <pre>{output}</pre>
    </section>
  );
}
function App() {
  const [workspace, setWorkspace] = useState("a");
  const [show, setShow] = useState(true);
  useEffect(() => {
    document.documentElement.dataset.ready = "true";
  }, []);
  return (
    <PersistentTerminalProvider>
      <nav>
        <button
          type="button"
          onClick={() => {
            setWorkspace("a");
            setShow(true);
          }}
        >
          Workspace A
        </button>
        <button
          type="button"
          onClick={() => {
            setWorkspace("b");
            setShow(true);
          }}
        >
          Workspace B
        </button>
        <button type="button" onClick={() => setShow(false)}>
          Git view
        </button>
      </nav>
      {show ? (
        <PersistentTerminal
          key={workspace}
          Runtime={Runtime}
          terminalProps={{ agentId: workspace, workspaceId: workspace, sessionName: "shell" }}
        />
      ) : (
        <p>Git view</p>
      )}
    </PersistentTerminalProvider>
  );
}
const app = document.getElementById("app");
if (app) createRoot(app).render(<App />);
