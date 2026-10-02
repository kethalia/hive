"use client";

import type { Terminal } from "@xterm/xterm";
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type { InteractiveTerminalProps } from "@/components/workspaces/InteractiveTerminal";
import type { ConnectionState, TerminalRecoveryState } from "@/hooks/useTerminalWebSocket";
import { TERMINAL_SESSION_FORGET_EVENT } from "@/lib/terminal/session-lifetime";

// Bound only parked surfaces. Visible panes are never evicted. The server-side
// tmux session remains available if a parked surface must be released.
const MAX_PARKED_TERMINALS = 24;
const PARKED_TERMINAL_TTL_MS = 30 * 60_000;

type Runtime = ComponentType<InteractiveTerminalProps>;
type Entry = {
  id: number;
  identity: string;
  host: HTMLDivElement;
  Runtime: Runtime;
  props: InteractiveTerminalProps;
  callbacks: Pick<
    InteractiveTerminalProps,
    "onTerminalReady" | "onTerminalDestroy" | "onConnectionStateChange" | "onRecoveryStateChange"
  >;
  attached: boolean;
  onForget?: () => void;
  releasedAt: number;
  expiresAt: number;
  term?: Terminal;
  send?: (data: string) => void;
  state?: ConnectionState;
  recovery?: TerminalRecoveryState;
};

function identity(props: InteractiveTerminalProps) {
  return JSON.stringify([
    props.workspaceId,
    props.agentId,
    props.sessionName,
    props.clonePath ?? "",
  ]);
}

class TerminalStore {
  entries: Entry[] = [];
  private listeners = new Set<() => void>();
  private sequence = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  active = true;
  cancelExpiry() {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }
  scheduleExpiry() {
    this.cancelExpiry();
    if (!this.active) return;
    const parked = this.entries.filter((entry) => !entry.attached);
    if (!parked.length) return;
    const next = Math.min(...parked.map((entry) => entry.expiresAt));
    this.expiryTimer = setTimeout(
      () => {
        this.evictExpired();
        this.publish();
        this.scheduleExpiry();
      },
      Math.max(0, next - Date.now()),
    );
  }
  private evictExpired() {
    const now = Date.now();
    this.entries = this.entries.filter((entry) => {
      if (entry.attached || entry.expiresAt > now) return true;
      entry.host.remove();
      return false;
    });
  }
  parking: HTMLDivElement | null = null;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.entries;
  private publish() {
    this.entries = [...this.entries];
    for (const listener of this.listeners) listener();
  }

  attach(
    props: InteractiveTerminalProps,
    target: HTMLDivElement,
    Runtime: Runtime,
    onForget: () => void,
  ) {
    this.evictExpired();
    const key = identity(props);
    // Simultaneous views have independent renderers/clients. Only a detached
    // view may be adopted by navigation to another route.
    let entry = this.entries.find((item) => item.identity === key && !item.attached);
    if (!entry) {
      const host = document.createElement("div");
      host.className = "flex h-full min-h-0 w-full flex-1 flex-col";
      entry = {
        id: ++this.sequence,
        identity: key,
        host,
        Runtime,
        props,
        attached: false,
        releasedAt: 0,
        expiresAt: 0,
        callbacks: {},
      };
      const current = entry;
      current.callbacks = {
        onTerminalReady: (term, send) => {
          current.term = term;
          current.send = send;
          if (current.attached) current.props.onTerminalReady?.(term, send);
        },
        onTerminalDestroy: () => {
          current.term = undefined;
          current.send = undefined;
          if (current.attached) current.props.onTerminalDestroy?.();
        },
        onConnectionStateChange: (state) => {
          current.state = state;
          if (current.attached) current.props.onConnectionStateChange?.(state);
        },
        onRecoveryStateChange: (recovery) => {
          current.recovery = recovery;
          if (current.attached) current.props.onRecoveryStateChange?.(recovery);
        },
      };
      this.entries.push(entry);
    }
    entry.props = props;
    entry.onForget = onForget;
    entry.attached = true;
    entry.host.inert = false;
    target.appendChild(entry.host);
    if (entry.term && entry.send) props.onTerminalReady?.(entry.term, entry.send);
    if (entry.state) props.onConnectionStateChange?.(entry.state);
    if (entry.recovery) props.onRecoveryStateChange?.(entry.recovery);
    this.publish();
    this.scheduleExpiry();
    return entry;
  }

  update(entry: Entry, props: InteractiveTerminalProps) {
    if (!this.entries.includes(entry)) return;
    const previous = entry.props;
    if (
      Object.keys({ ...previous, ...props }).every(
        (key) =>
          previous[key as keyof InteractiveTerminalProps] ===
          props[key as keyof InteractiveTerminalProps],
      )
    )
      return;
    entry.props = props;
    this.publish();
  }

  release(entry: Entry) {
    if (!this.entries.includes(entry)) return;
    entry.attached = false;
    entry.onForget = undefined;
    entry.host.inert = true;
    entry.releasedAt = ++this.sequence;
    entry.expiresAt = Date.now() + PARKED_TERMINAL_TTL_MS;
    // Blur before parking: background terminals must not retain keyboard focus.
    if (entry.host.contains(document.activeElement))
      (document.activeElement as HTMLElement)?.blur();
    this.parking?.appendChild(entry.host);
    entry.props.onTerminalDestroy?.();
    const parked = this.entries
      .filter((item) => !item.attached)
      .sort((a, b) => b.releasedAt - a.releasedAt);
    const evicted = new Set(parked.slice(MAX_PARKED_TERMINALS));
    this.entries = this.entries.filter((item) => !evicted.has(item));
    for (const item of evicted) item.host.remove();
    this.publish();
    this.scheduleExpiry();
  }

  forget(workspaceId: string, sessionName: string) {
    const removed = this.entries.filter(
      (entry) => entry.props.workspaceId === workspaceId && entry.props.sessionName === sessionName,
    );
    this.entries = this.entries.filter((entry) => !removed.includes(entry));
    for (const entry of removed) {
      entry.host.remove();
      entry.onForget?.();
    }
    this.publish();
    this.scheduleExpiry();
  }
}

const TerminalStoreContext = createContext<TerminalStore | null>(null);

export function PersistentTerminalProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new TerminalStore());
  const entries = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  useLayoutEffect(() => {
    store.active = true;
    store.scheduleExpiry();
    const forget = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string; sessionName: string }>).detail;
      if (typeof detail?.workspaceId === "string" && typeof detail.sessionName === "string")
        store.forget(detail.workspaceId, detail.sessionName);
    };
    window.addEventListener(TERMINAL_SESSION_FORGET_EVENT, forget);
    return () => {
      store.active = false;
      store.cancelExpiry();
      window.removeEventListener(TERMINAL_SESSION_FORGET_EVENT, forget);
    };
  }, [store]);
  return (
    <TerminalStoreContext.Provider value={store}>
      {children}
      <div
        hidden
        inert
        aria-hidden="true"
        ref={(node) => {
          store.parking = node;
        }}
      />
      {entries.map((entry) =>
        createPortal(
          <entry.Runtime
            {...entry.props}
            {...entry.callbacks}
            suppressAutoFocus={!entry.attached || entry.props.suppressAutoFocus}
          />,
          entry.host,
          String(entry.id),
        ),
      )}
    </TerminalStoreContext.Provider>
  );
}

function PersistentTerminalView({
  terminalProps,
  Runtime,
  store,
}: {
  terminalProps: InteractiveTerminalProps;
  Runtime: Runtime;
  store: TerminalStore;
}) {
  const target = useRef<HTMLDivElement>(null);
  const [closed, setClosed] = useState(false);
  const entry = useRef<Entry | null>(null);
  const propsRef = useRef(terminalProps);
  propsRef.current = terminalProps;
  const key = identity(terminalProps);
  useLayoutEffect(() => {
    void key; // A different session identity must acquire its own surface.
    if (!target.current) return;
    setClosed(false);
    const current = store.attach(propsRef.current, target.current, Runtime, () => setClosed(true));
    entry.current = current;
    return () => {
      entry.current = null;
      store.release(current);
    };
  }, [store, key, Runtime]);
  useLayoutEffect(() => {
    if (entry.current) store.update(entry.current, terminalProps);
  });
  return (
    <div ref={target} className="flex h-full min-h-0 w-full flex-1 flex-col">
      {closed ? (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          This terminal session was closed or renamed.
        </p>
      ) : null}
    </div>
  );
}

export function PersistentTerminal({
  terminalProps,
  Runtime,
}: {
  terminalProps: InteractiveTerminalProps;
  Runtime: Runtime;
}) {
  const store = useContext(TerminalStoreContext);
  // Standalone embeds retain their existing local lifetime.
  return store ? (
    <PersistentTerminalView terminalProps={terminalProps} Runtime={Runtime} store={store} />
  ) : (
    <Runtime {...terminalProps} />
  );
}
