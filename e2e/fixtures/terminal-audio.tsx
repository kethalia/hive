import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { TerminalAudioBridge } from "../../src/components/terminal/TerminalAudioBridge";
import { TerminalSessionFrame } from "../../src/components/workspaces/TerminalSessionFrame";
import { primeTerminalAudio } from "../../src/lib/terminal/audio-interaction";
import { TERMINAL_NOTIFICATION_FOCUS_EVENT } from "../../src/lib/terminal/events";

const probe = {
  requests: 0,
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
  probe.requests++;
  const stream = await getUserMedia(constraints);
  probe.tracks.push(...stream.getTracks());
  return stream;
};

function Fixture() {
  const duplicate = location.pathname === "/duplicate";
  const sessions = location.pathname === "/panes" || duplicate ? ["first", "second"] : ["test"];
  const [selected, setSelected] = useState(sessions[0]);
  useEffect(() => {
    const navigate = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      setSelected(detail.sessionName);
      document
        .querySelector<HTMLTextAreaElement>(`[data-session="${detail.sessionName}"] textarea`)
        ?.focus();
      event.preventDefault();
    };
    window.addEventListener(TERMINAL_NOTIFICATION_FOCUS_EVENT, navigate);
    return () => window.removeEventListener(TERMINAL_NOTIFICATION_FOCUS_EVENT, navigate);
  }, []);
  return (
    <main className="flex h-dvh flex-col bg-background p-4 text-foreground">
      <Toaster />
      {sessions.length > 1 ? (
        <nav>
          {sessions.map((name) => (
            <button key={name} type="button" onClick={() => setSelected(name)}>
              Select {name} pane
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              primeTerminalAudio(document.querySelector(`[data-session="${selected}"]`));
              void fetch(`/native?sessionName=${duplicate ? "test" : selected}`, {
                method: "POST",
                body: "/voice",
              });
            }}
          >
            Send voice to selected pane
          </button>
        </nav>
      ) : null}
      {sessions.map((name) => (
        <section key={name} className="flex min-h-0 flex-1 flex-col">
          <Pane
            name={name}
            active={selected === name}
            sessionName={duplicate ? "test" : name}
            select={() => setSelected(name)}
          />
        </section>
      ))}
    </main>
  );
}

function Pane({
  name,
  sessionName,
  select,
  active,
}: {
  name: string;
  sessionName: string;
  select: () => void;
  active: boolean;
}) {
  const [value, setValue] = useState("");
  return (
    <div data-session={name} className="flex min-h-0 flex-1 flex-col">
      <TerminalSessionFrame
        label={name}
        subtitle={`projects/kethalia/${name}`}
        active={active}
        onActivate={select}
        onOpenActions={() => {}}
        onClose={() => {}}
        dragHandleListeners={{ onPointerDown: () => {} }}
      >
        <div
          data-terminal-surface="true"
          onKeyDownCapture={(event) => {
            if (event.key === "Enter") primeTerminalAudio(event.currentTarget);
          }}
          className="relative flex min-h-0 flex-1 flex-col rounded border p-4"
        >
          <TerminalAudioBridge
            proxyUrl={location.origin.replace(/^http/, "ws")}
            workspaceId="workspace"
            agentId="agent"
            sessionName={sessionName}
            onFocusTerminal={() => {
              select();
              document
                .querySelector<HTMLTextAreaElement>(`[data-session="${name}"] textarea`)
                ?.focus();
            }}
            onStartVoice={() => {
              void fetch(`/native?sessionName=${sessionName}`, { method: "POST", body: "/voice" });
            }}
          />
          <p>Codex terminal</p>
          <textarea
            aria-label={name === "test" ? "Terminal input" : `${name} terminal input`}
            className="mt-auto w-full rounded bg-muted p-2"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onFocus={select}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void fetch(`/native?sessionName=${sessionName}`, { method: "POST", body: value });
              setValue("");
            }}
          />
        </div>
      </TerminalSessionFrame>
    </div>
  );
}
createRoot(document.getElementById("app") as HTMLElement).render(<Fixture />);
