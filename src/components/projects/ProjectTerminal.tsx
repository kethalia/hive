"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import "@xterm/xterm/css/xterm.css";

const grantSchema = z
  .object({
    url: z.string().max(2048),
    ticket: z.string().min(1).max(8192),
    expiresAt: z.number().int(),
    binding: z
      .object({
        ownerId: z.string(),
        workspaceId: z.string(),
        buildId: z.string(),
        serverInstanceId: z.string(),
        threadId: z.string(),
      })
      .strict(),
    protocolVersion: z.literal("0.165.0"),
  })
  .strict();
const frameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }).strict(),
  z.object({ type: z.literal("output"), text: z.string().max(65536) }).strict(),
  z.object({ type: z.literal("exit"), code: z.number().int().nullable() }).strict(),
  z.object({ type: z.literal("renewed"), expiresAt: z.number().int() }).strict(),
]);
/** Attaches a PTY to the already-registered tmux session. Hidden tabs retain their
 * socket; visibility changes only resize it and never start another native agent. */
export function ProjectTerminal({ projectId, visible }: { projectId: string; visible: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const fit = useRef<(() => void) | null>(null);
  const [error, setError] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (visible) fit.current?.();
  }, [visible]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation explicitly reattaches this terminal after an error.
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let terminal: import("@xterm/xterm").Terminal | undefined;
    let resize: ResizeObserver | undefined;
    let renewal: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let handshake: ReturnType<typeof setTimeout> | undefined;
    let pendingBytes = 0;
    let ready = false;
    const controller = new AbortController();
    const fail = () => {
      clearTimeout(renewal);
      clearTimeout(expiry);
      clearTimeout(handshake);
      controller.abort();
      ready = false;
      socket?.close();
      if (!disposed) setError(true);
    };
    const fresh = async () => {
      const response = await fetch(`/api/projects/${projectId}/terminal-grant`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok) throw new Error("Terminal unavailable");
      const grant = grantSchema.parse(await response.json());
      const url = new URL(grant.url);
      if (
        url.origin !== window.location.origin ||
        url.pathname !== `/api/projects/${projectId}/terminal` ||
        url.search ||
        url.hash ||
        url.username ||
        url.password ||
        grant.expiresAt * 1000 <= Date.now() ||
        grant.expiresAt * 1000 > Date.now() + 60000
      )
        throw new Error("Invalid terminal authorization");
      return grant;
    };
    const send = (value: unknown) => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      const encoded = JSON.stringify(value);
      if (new TextEncoder().encode(encoded).length > 65536 || socket.bufferedAmount > 262144) {
        fail();
        return;
      }
      socket.send(encoded);
    };
    const run = async () => {
      const [{ Terminal }, { FitAddon }, grant] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        fresh(),
      ]);
      if (disposed || !element.current) return;
      terminal = new Terminal({
        cursorBlink: true,
        scrollback: 5000,
        fontSize: 13,
        theme: { background: "#101010" },
        allowProposedApi: false,
      });
      const addon = new FitAddon();
      terminal.loadAddon(addon);
      terminal.open(element.current);
      fit.current = () => {
        if (element.current?.clientWidth && element.current?.clientHeight) addon.fit();
      };
      fit.current();
      const endpoint = new URL(grant.url);
      endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(endpoint.href);
      const binding = JSON.stringify(grant.binding);
      let current = grant;
      let pending: typeof grant | undefined;
      const schedule = () => {
        clearTimeout(renewal);
        clearTimeout(expiry);
        const remaining = current.expiresAt * 1000 - Date.now();
        expiry = setTimeout(fail, Math.max(0, remaining));
        renewal = setTimeout(
          () => {
            void (async () => {
              const next = await fresh();
              if (disposed) return;
              if (
                next.url !== current.url ||
                JSON.stringify(next.binding) !== binding ||
                next.expiresAt <= current.expiresAt ||
                next.ticket === current.ticket
              )
                throw new Error("Terminal binding changed");
              pending = next;
              send({ type: "renew", ticket: next.ticket });
            })().catch(fail);
          },
          Math.max(1000, Math.min(40000, remaining - 10000)),
        );
      };
      handshake = setTimeout(fail, 5000);
      socket.addEventListener("open", () => send({ type: "authenticate", ticket: grant.ticket }));
      socket.addEventListener("message", (event) => {
        try {
          if (
            typeof event.data !== "string" ||
            new TextEncoder().encode(event.data).length > 262144
          )
            throw new Error("Invalid frame");
          const frame = frameSchema.parse(JSON.parse(event.data));
          if (frame.type === "ready") {
            if (ready) throw new Error("Repeated ready");
            clearTimeout(handshake);
            ready = true;
            schedule();
            send({
              type: "resize",
              cols: Math.max(2, Math.min(500, terminal?.cols ?? 80)),
              rows: Math.max(2, Math.min(500, terminal?.rows ?? 24)),
            });
          } else if (!ready) throw new Error("Terminal not authenticated");
          else if (frame.type === "output") {
            pendingBytes += new TextEncoder().encode(frame.text).length;
            if (pendingBytes > 1048576) throw new Error("Output overflow");
            const bytes = new TextEncoder().encode(frame.text).length;
            terminal?.write(frame.text, () => {
              pendingBytes -= bytes;
            });
          } else if (frame.type === "renewed") {
            if (!pending || frame.expiresAt !== pending.expiresAt)
              throw new Error("Invalid renewal");
            current = pending;
            pending = undefined;
            schedule();
          } else fail();
        } catch {
          fail();
        }
      });
      socket.addEventListener("close", (event) => {
        if (event.code === 1008) terminal?.reset();
        fail();
      });
      socket.addEventListener("error", fail);
      terminal.onData((text) => {
        if (ready) send({ type: "input", text });
      });
      terminal.onResize(({ cols, rows }) => {
        if (ready)
          send({
            type: "resize",
            cols: Math.max(2, Math.min(500, cols)),
            rows: Math.max(2, Math.min(500, rows)),
          });
      });
      resize = new ResizeObserver(() => fit.current?.());
      resize.observe(element.current);
    };
    setError(false);
    void run().catch(fail);
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(renewal);
      clearTimeout(expiry);
      clearTimeout(handshake);
      resize?.disconnect();
      socket?.close();
      terminal?.dispose();
      fit.current = null;
    };
  }, [projectId, generation]);
  return (
    <section aria-label="Project terminal" className="flex h-full min-h-0 flex-col">
      {error ? (
        <div role="alert" className="flex items-center justify-between gap-2 p-2 text-sm">
          <span>Terminal connection closed. The project session remains in the workspace.</span>
          <Button size="sm" variant="outline" onClick={() => setGeneration((n) => n + 1)}>
            Reconnect
          </Button>
        </div>
      ) : null}
      <div ref={element} className="min-h-0 flex-1" />
    </section>
  );
}
