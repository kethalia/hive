import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as rtl from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach } from "vitest";

const clients = new Set<QueryClient>();
afterEach(() => {
  for (const client of clients) client.clear();
  clients.clear();
});
function wrapper(Wrapper?: ComponentType<{ children: ReactNode }>) {
  const client = new QueryClient();
  clients.add(client);
  return function DiscoveryTestProvider({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        {Wrapper ? <Wrapper>{children}</Wrapper> : children}
      </QueryClientProvider>
    );
  };
}

export * from "@testing-library/react";
export const render = (ui: ReactNode, options?: rtl.RenderOptions) =>
  rtl.render(ui, { ...options, wrapper: wrapper(options?.wrapper) });
export const renderHook: typeof rtl.renderHook = (hook, options) =>
  rtl.renderHook(hook, { ...options, wrapper: wrapper(options?.wrapper) });
