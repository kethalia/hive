"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SessionView } from "@/lib/codex-session/adapter";
import type { SessionItem } from "@/lib/codex-session/protocol";

const PHASE_LABELS: Record<SessionView["phase"], string> = {
  disconnected: "Disconnected",
  loading: "Updating conversation",
  live: "Connected",
  "awaiting-first-turn": "Waiting for the first message",
  unavailable: "Conversation unavailable",
  error: "Connection failed",
};

function ConversationItem({ item }: { item: SessionItem }) {
  if (item.type === "commandExecution") {
    return (
      <details className="rounded-md border border-border p-3 text-sm">
        <summary className="cursor-pointer break-words font-medium">
          Command · {item.status ?? "Unknown"}
          {item.exitCode !== null && item.exitCode !== undefined ? ` · Exit ${item.exitCode}` : ""}
        </summary>
        <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
          {item.command}
        </pre>
        <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
          {item.aggregatedOutput ?? "No output yet."}
        </pre>
      </details>
    );
  }
  if (item.unsupported) {
    return <p className="text-xs text-muted-foreground">This activity is available in Terminal.</p>;
  }
  const user = item.type === "userMessage";
  const content = user
    ? item.content?.map((part) => part.text ?? "[Attachment]").join("\n")
    : item.text;
  return (
    <article
      aria-label={user ? "Your message" : item.type === "plan" ? "Plan" : "Codex message"}
      className={user ? "ml-auto max-w-[90%] rounded-xl bg-muted px-4 py-3" : "max-w-full py-2"}
    >
      <p className="mb-1 text-xs font-medium text-muted-foreground">
        {user ? "You" : item.type === "plan" ? "Plan" : "Codex"}
      </p>
      <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{content}</div>
    </article>
  );
}

export interface ConversationViewProps {
  sessionKey: string;
  view: SessionView;
  onReconnect: () => void;
  onOpenTerminal: () => void;
}

/** Display-only subscription view. Mount it alongside the persistent terminal;
 * changing visibility must not create, resume, or terminate a native agent.
 */
export function ConversationView(props: ConversationViewProps) {
  return <ConversationContents key={props.sessionKey} {...props} />;
}

function ConversationContents({ view, onReconnect, onOpenTerminal }: ConversationViewProps) {
  const scroller = useRef<HTMLElement>(null);
  const followLatest = useRef(true);
  const prependAnchor = useRef<{ height: number; top: number } | null>(null);
  const [visibleCount, setVisibleCount] = useState(40);
  const [showLatest, setShowLatest] = useState(false);
  const hiddenCount = Math.max(0, view.turns.length - visibleCount);

  useEffect(() => {
    if (!view.turns.length) return;
    if (followLatest.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
    else setShowLatest(true);
  }, [view.turns]);

  useLayoutEffect(() => {
    const anchor = prependAnchor.current;
    if (anchor && scroller.current && visibleCount > 40) {
      scroller.current.scrollTop = anchor.top + scroller.current.scrollHeight - anchor.height;
      prependAnchor.current = null;
    }
  }, [visibleCount]);

  return (
    <section aria-label="Codex conversation" className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <Badge variant={view.phase === "error" ? "destructive" : "secondary"}>
          {PHASE_LABELS[view.phase]}
        </Badge>
        {view.needsRefresh && view.phase === "live" ? (
          <span role="status" className="text-xs text-muted-foreground">
            Updating recent activity…
          </span>
        ) : null}
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onOpenTerminal}>
          Continue in Terminal
        </Button>
      </header>
      {view.error ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-border p-3 text-sm"
        >
          <span>The conversation could not be loaded.</span>
          <Button variant="outline" size="sm" onClick={onReconnect}>
            Reconnect
          </Button>
        </div>
      ) : null}
      <section
        ref={scroller}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable history must be keyboard reachable.
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto overscroll-contain p-4"
        aria-label="Conversation history"
        onScroll={(event) => {
          const target = event.currentTarget;
          followLatest.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80;
          if (followLatest.current) setShowLatest(false);
        }}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
          {hiddenCount > 0 ? (
            <Button
              variant="ghost"
              onClick={() => {
                followLatest.current = false;
                if (scroller.current)
                  prependAnchor.current = {
                    height: scroller.current.scrollHeight,
                    top: scroller.current.scrollTop,
                  };
                setVisibleCount((count) => count + 40);
              }}
            >
              Show earlier activity ({hiddenCount} turns)
            </Button>
          ) : null}
          {!view.turns.length ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {view.phase === "loading" ? "Loading conversation…" : "No messages to display yet."}
            </p>
          ) : null}
          {view.turns.slice(-visibleCount).map((turn) => (
            <div key={turn.id} className="flex flex-col gap-3" data-turn-id={turn.id}>
              {turn.items.map((item) => (
                <ConversationItem key={item.id} item={item} />
              ))}
              {turn.itemsView !== "full" ? (
                <p className="text-xs text-muted-foreground">
                  Some activity is available in Terminal.
                </p>
              ) : null}
              {turn.status === "failed" || turn.status === "interrupted" ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {turn.status === "failed" ? "This turn failed." : "This turn was interrupted."}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      </section>
      {showLatest ? (
        <Button
          variant="secondary"
          className="mx-auto my-2"
          onClick={() => {
            followLatest.current = true;
            if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
            setShowLatest(false);
          }}
        >
          Latest activity
        </Button>
      ) : null}
    </section>
  );
}
