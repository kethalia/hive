import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TerminalAudioBridge } from "../../src/components/terminal/TerminalAudioBridge";

const probe = {
  contexts: [] as AudioContext[],
  tracks: [] as MediaStreamTrack[],
  analysers: [] as AnalyserNode[],
};
Object.assign(window, { audioProbe: probe });
const Context = window.AudioContext;
window.AudioContext = class extends Context {
  constructor(options?: AudioContextOptions) {
    super(options);
    probe.contexts.push(this);
  }
};
const Worklet = window.AudioWorkletNode;
window.AudioWorkletNode = class extends Worklet {
  constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
    super(context, name, options);
    const analyser = context.createAnalyser();
    super.connect(analyser);
    probe.analysers.push(analyser);
  }
};
const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async (constraints) => {
  const stream = await getUserMedia(constraints);
  probe.tracks.push(...stream.getTracks());
  return stream;
};

function Fixture() {
  const [value, setValue] = useState("");
  return (
    <main className="flex h-dvh flex-col bg-background p-4 text-foreground">
      <div
        data-terminal-surface="true"
        className="relative flex min-h-0 flex-1 flex-col rounded border p-4"
      >
        <TerminalAudioBridge
          proxyUrl={location.origin.replace(/^http/, "ws")}
          workspaceId="workspace"
          agentId="agent"
          sessionName="test"
        />
        <p>Codex terminal</p>
        <textarea
          aria-label="Terminal input"
          className="mt-auto w-full rounded bg-muted p-2"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void fetch("/native", { method: "POST", body: value });
            setValue("");
          }}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById("app") as HTMLElement).render(<Fixture />);
