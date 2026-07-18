"use client";

import { createContext, type ReactNode, useContext, useMemo, useSyncExternalStore } from "react";
import type { RuntimeConfig } from "@/lib/runtime-config";
import { getClientRuntimeConfig, resolveTerminalWsUrl } from "@/lib/runtime-config";

const RuntimeConfigContext = createContext<RuntimeConfig | null>(null);

export function RuntimeConfigProvider({
  children,
  config,
}: {
  children: ReactNode;
  config: RuntimeConfig;
}) {
  return <RuntimeConfigContext.Provider value={config}>{children}</RuntimeConfigContext.Provider>;
}

const subscribeToBrowserLocation = () => () => undefined;

export function useRuntimeConfig(): RuntimeConfig {
  const providedConfig = useContext(RuntimeConfigContext);
  const configuredUrl = providedConfig?.terminalWsUrl;
  const terminalWsUrl = useSyncExternalStore(
    subscribeToBrowserLocation,
    () =>
      resolveTerminalWsUrl(
        configuredUrl ?? getClientRuntimeConfig().terminalWsUrl,
        window.location,
      ),
    () => configuredUrl ?? getClientRuntimeConfig().terminalWsUrl,
  );

  return useMemo(() => ({ terminalWsUrl }), [terminalWsUrl]);
}
