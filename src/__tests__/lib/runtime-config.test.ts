import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getClientRuntimeConfig, getServerRuntimeConfig } from "@/lib/runtime-config";

describe("runtime-config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    if (typeof globalThis !== "undefined") {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  describe("getServerRuntimeConfig", () => {
    it("reads terminalWsUrl from NEXT_PUBLIC_TERMINAL_WS_URL", () => {
      vi.stubEnv("NEXT_PUBLIC_TERMINAL_WS_URL", "wss://terminal.example.com/ws");
      expect(getServerRuntimeConfig()).toEqual({
        terminalWsUrl: "wss://terminal.example.com/ws",
      });
    });

    it("falls back to empty string when env var is unset", () => {
      vi.stubEnv("NEXT_PUBLIC_TERMINAL_WS_URL", "");
      expect(getServerRuntimeConfig()).toEqual({ terminalWsUrl: "" });
    });
  });

  describe("getClientRuntimeConfig", () => {
    beforeEach(() => {
      (globalThis as { window?: unknown }).window = {};
    });

    it("prefers window.__HIVE_CONFIG__ over process.env", () => {
      vi.stubEnv("NEXT_PUBLIC_TERMINAL_WS_URL", "wss://from-env.example.com/ws");
      (globalThis as { window: { __HIVE_CONFIG__?: unknown } }).window.__HIVE_CONFIG__ = {
        terminalWsUrl: "wss://from-window.example.com/ws",
      };

      expect(getClientRuntimeConfig()).toEqual({
        terminalWsUrl: "wss://from-window.example.com/ws",
      });
    });

    it("falls back to process.env when window.__HIVE_CONFIG__ is absent", () => {
      vi.stubEnv("NEXT_PUBLIC_TERMINAL_WS_URL", "wss://from-env.example.com/ws");

      expect(getClientRuntimeConfig()).toEqual({
        terminalWsUrl: "wss://from-env.example.com/ws",
      });
    });

    it("returns empty string when neither source provides a value", () => {
      vi.stubEnv("NEXT_PUBLIC_TERMINAL_WS_URL", "");
      expect(getClientRuntimeConfig()).toEqual({ terminalWsUrl: "" });
    });
  });
});
