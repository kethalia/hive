// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { RuntimeConfigProvider, useRuntimeConfig } from "@/components/runtime-config-provider";

describe("RuntimeConfigProvider", () => {
  it("makes server runtime config available synchronously to client descendants", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RuntimeConfigProvider config={{ terminalWsUrl: "wss://terminal.example.test" }}>
        {children}
      </RuntimeConfigProvider>
    );

    const { result } = renderHook(() => useRuntimeConfig(), { wrapper });

    expect(result.current).toEqual({ terminalWsUrl: "wss://terminal.example.test" });
  });

  it("resolves a server-provided relative URL during a client-side transition", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RuntimeConfigProvider config={{ terminalWsUrl: "/terminal" }}>
        {children}
      </RuntimeConfigProvider>
    );

    const { result } = renderHook(() => useRuntimeConfig(), { wrapper });

    expect(result.current).toEqual({ terminalWsUrl: "ws://localhost:3000/terminal" });
  });
});
