"use client";

import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";

import { useDiscovery } from "@/lib/discovery/queries";

function DiscoveryEvents() {
  // One poller per authenticated dashboard; every consumer observes the same query.
  useDiscovery("workspaces", {}, { poll: true });
  const client = useQueryClient();
  useEffect(() => {
    const refresh = () => {
      void client.invalidateQueries({ queryKey: ["discovery"] });
    };
    const clear = () => client.clear();
    const sessions = (event: Event) => {
      const { workspaceId } = (event as CustomEvent<{ workspaceId: string }>).detail;
      void client.invalidateQueries({ queryKey: ["discovery", "sessions", workspaceId] });
      void client.invalidateQueries({ queryKey: ["discovery", "agent-tools", workspaceId] });
    };
    window.addEventListener("hive:discovery-refresh", refresh);
    window.addEventListener("hive:discovery-clear", clear);
    window.addEventListener("hive:terminal-session-forget", sessions);
    return () => {
      window.removeEventListener("hive:discovery-refresh", refresh);
      window.removeEventListener("hive:discovery-clear", clear);
      window.removeEventListener("hive:terminal-session-forget", sessions);
    };
  }, [client]);
  return null;
}

export function DiscoveryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>
      <DiscoveryEvents />
      {children}
    </QueryClientProvider>
  );
}
