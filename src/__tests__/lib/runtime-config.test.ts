import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getClientRuntimeConfig,
  getServerRuntimeConfig,
  parseRuntimeConfig,
  RUNTIME_CONFIG_ELEMENT_ID,
  resolveTerminalWsUrl,
  serializeRuntimeConfig,
  serializeRuntimeConfigScript,
} from "@/lib/runtime-config";

describe("runtime-config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (typeof globalThis !== "undefined") {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  describe("getServerRuntimeConfig", () => {
    it("exposes repository discovery only through the explicit server flag", () => {
      vi.stubEnv("HIVE_PROJECT_DISCOVERY_ENABLED", "false");
      expect(getServerRuntimeConfig().projectDiscoveryEnabled).toBeUndefined();
      vi.stubEnv("HIVE_PROJECT_DISCOVERY_ENABLED", "true");
      const config = getServerRuntimeConfig();
      expect(parseRuntimeConfig(serializeRuntimeConfig(config))?.projectDiscoveryEnabled).toBe(
        true,
      );
      expect(
        parseRuntimeConfig('{"terminalWsUrl":"","projectDiscoveryEnabled":"true"}')
          ?.projectDiscoveryEnabled,
      ).toBeUndefined();
    });
    it("exposes voice only when explicitly enabled and preserves it through serialization", () => {
      vi.stubEnv("HIVE_CODEX_VOICE_ENABLED", "true");
      const config = getServerRuntimeConfig();
      expect(config.codexVoiceEnabled).toBe(true);
      expect(parseRuntimeConfig(serializeRuntimeConfig(config))?.codexVoiceEnabled).toBe(true);
      vi.stubEnv("HIVE_CODEX_VOICE_ENABLED", "false");
      expect(getServerRuntimeConfig().codexVoiceEnabled).toBeUndefined();
      expect(
        parseRuntimeConfig('{"terminalWsUrl":"","codexVoiceEnabled":"true"}')?.codexVoiceEnabled,
      ).toBeUndefined();
    });
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

    it("uses only the explicit same-origin Worker terminal setting", () => {
      vi.stubEnv("NEXT_PUBLIC_TERMINAL_WS_URL", "wss://node.example/ws");
      vi.stubEnv("HIVE_RUNTIME_TARGET", "cloudflare");
      vi.stubEnv("HIVE_TERMINAL_WS_URL", "/");
      expect(getServerRuntimeConfig().terminalWsUrl).toBe("/");
      vi.stubEnv("HIVE_TERMINAL_WS_URL", "https://other.example");
      expect(getServerRuntimeConfig().terminalWsUrl).toBe("");
      vi.stubEnv("HIVE_RUNTIME_TARGET", "node");
      expect(getServerRuntimeConfig().terminalWsUrl).toBe("wss://node.example/ws");
    });
  });

  describe("workspace menu capabilities", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    it("publishes only configured template IDs/booleans, never pins or issuer secrets", () => {
      vi.stubEnv("HIVE_RUNTIME_TARGET", "cloudflare");
      vi.stubEnv("HIVE_CODEX_GATEWAY_ENABLED", "true");
      vi.stubEnv("HIVE_PROJECT_DISCOVERY_ENABLED", "true");
      vi.stubEnv("HIVE_CODEX_SOFTWARE_TEMPLATE_IDS", id);
      vi.stubEnv("HIVE_WORKSPACE_READ_ENABLED", "true");
      vi.stubEnv(
        "HIVE_WORKSPACE_READ_PROFILES_JSON",
        JSON.stringify([{ templateId: id, profile: "software", manifestSha256: "a".repeat(64) }]),
      );
      vi.stubEnv("HIVE_WORKSPACE_READ_ISSUER_PRIVATE_KEY", "private-never-publish");
      vi.stubEnv("HIVE_GENERIC_TERMINAL_ENABLED", "false");
      const config = getServerRuntimeConfig(),
        json = serializeRuntimeConfig(config);
      expect(config.workspaceCapabilities).toEqual({
        projectTemplateIds: [id],
        readTemplateIds: [id],
        terminalEnabled: false,
      });
      expect(parseRuntimeConfig(json)?.workspaceCapabilities).toEqual(config.workspaceCapabilities);
      expect(json).not.toContain("private-never-publish");
      expect(json).not.toContain("manifestSha256");
      vi.stubEnv("HIVE_WORKSPACE_READ_ENABLED", "false");
      vi.stubEnv("HIVE_GENERIC_TERMINAL_ENABLED", "true");
      expect(getServerRuntimeConfig().workspaceCapabilities).toEqual({
        projectTemplateIds: [id],
        readTemplateIds: [],
        terminalEnabled: true,
      });
    });
    it("keeps malformed portable capability data unavailable rather than restoring legacy clone behavior", () => {
      for (const raw of [
        null,
        {},
        "true",
        { projectTemplateIds: [id, id], readTemplateIds: ["bad"], terminalEnabled: "true" },
      ]) {
        expect(
          parseRuntimeConfig(JSON.stringify({ terminalWsUrl: "/", workspaceCapabilities: raw }))
            ?.workspaceCapabilities,
        ).toEqual({ projectTemplateIds: [], readTemplateIds: [], terminalEnabled: false });
      }
      vi.stubEnv("HIVE_RUNTIME_TARGET", "cloudflare");
      vi.stubEnv("HIVE_WORKSPACE_READ_ENABLED", "true");
      vi.stubEnv("HIVE_WORKSPACE_READ_PROFILES_JSON", "not-json");
      expect(getServerRuntimeConfig().workspaceCapabilities?.readTemplateIds).toEqual([]);
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

    it("reads the non-executable JSON data island when the window assignment is absent", () => {
      vi.stubEnv("NEXT_PUBLIC_TERMINAL_WS_URL", "wss://from-env.example.com/ws");
      vi.stubGlobal("document", {
        getElementById: (id: string) =>
          id === RUNTIME_CONFIG_ELEMENT_ID
            ? { textContent: '{"terminalWsUrl":"wss://from-dom.example.com/ws"}' }
            : null,
      });

      expect(getClientRuntimeConfig()).toEqual({
        terminalWsUrl: "wss://from-dom.example.com/ws",
      });
    });

    it("returns empty string when neither source provides a value", () => {
      vi.stubEnv("NEXT_PUBLIC_TERMINAL_WS_URL", "");
      expect(getClientRuntimeConfig()).toEqual({ terminalWsUrl: "" });
    });
  });

  describe("serializeRuntimeConfig", () => {
    it("creates JSON for a non-executable data island", () => {
      expect(serializeRuntimeConfig({ terminalWsUrl: "/" })).toBe('{"terminalWsUrl":"/"}');
    });

    it("escapes script-breaking characters", () => {
      const serialized = serializeRuntimeConfig({
        terminalWsUrl: "</script>\u2028\u2029",
      });

      expect(serialized).not.toContain("</script>");
      expect(serialized).toContain("\\u003c/script>");
      expect(serialized).toContain("\\u2028");
      expect(serialized).toContain("\\u2029");
    });
  });

  describe("serializeRuntimeConfigScript", () => {
    it("creates an executable assignment for the legacy JavaScript route", () => {
      expect(serializeRuntimeConfigScript({ terminalWsUrl: "/" })).toBe(
        'window.__HIVE_CONFIG__={"terminalWsUrl":"/"};',
      );
    });

    it("retains script-breaking escaping in executable compatibility output", () => {
      expect(serializeRuntimeConfigScript({ terminalWsUrl: "</script>" })).toBe(
        'window.__HIVE_CONFIG__={"terminalWsUrl":"\\u003c/script>"};',
      );
    });
  });

  describe("resolveTerminalWsUrl", () => {
    it("keeps an absolute terminal URL unchanged", () => {
      expect(
        resolveTerminalWsUrl("wss://terminal.example.com", {
          host: "hive.example.com",
          protocol: "https:",
        }),
      ).toBe("wss://terminal.example.com");
    });

    it("keeps a protocol-relative terminal URL unchanged", () => {
      expect(
        resolveTerminalWsUrl("//terminal.example.com", {
          host: "hive.example.com",
          protocol: "https:",
        }),
      ).toBe("//terminal.example.com");
    });

    it("resolves a root-relative URL against an HTTPS browser host", () => {
      expect(
        resolveTerminalWsUrl("/", {
          host: "hive.kethalia.com",
          protocol: "https:",
        }),
      ).toBe("wss://hive.kethalia.com");
    });

    it("preserves a relative path and uses ws for HTTP", () => {
      expect(
        resolveTerminalWsUrl("/terminal/", {
          host: "localhost:3000",
          protocol: "http:",
        }),
      ).toBe("ws://localhost:3000/terminal");
    });

    it("returns an empty URL when a relative URL has no browser host", () => {
      expect(resolveTerminalWsUrl("/")).toBe("");
    });
  });
});

it("only exposes delivery when explicitly enabled by the server", () => {
  vi.stubEnv("HIVE_DELIVERY_ENABLED", "false");
  expect(getServerRuntimeConfig().deliveryEnabled).toBeUndefined();
  vi.stubEnv("HIVE_DELIVERY_ENABLED", "true");
  expect(getServerRuntimeConfig().deliveryEnabled).toBe(true);
  expect(parseRuntimeConfig('{"terminalWsUrl":"","deliveryEnabled":true}')?.deliveryEnabled).toBe(
    true,
  );
  expect(
    parseRuntimeConfig('{"terminalWsUrl":"","deliveryEnabled":"true"}')?.deliveryEnabled,
  ).toBeUndefined();
  vi.unstubAllEnvs();
});
