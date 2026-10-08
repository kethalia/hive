import { createRoot } from "react-dom/client";
import { CodexVoiceControls } from "../../src/components/terminal/CodexVoiceControls";

const root = document.getElementById("app");
if (!root) throw new Error("Voice fixture root is missing");
createRoot(root).render(
  <main className="min-h-screen bg-background p-3 text-foreground">
    <h1>Codex browser voice prototype</h1>
    <CodexVoiceControls workspaceId="voice-workspace" />
  </main>,
);
