// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { checkAppVersion, refreshInstalledApp } from "@/lib/app-update";
import { hasAppUpdate } from "@/lib/app-version";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("checkAppVersion", () => {
  it("fetches validated deployed metadata without using the browser cache", async () => {
    const deployed = { version: "2.21.7", buildId: "new-build" };
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => deployed });
    vi.stubGlobal("fetch", fetch);
    expect(await checkAppVersion()).toEqual(deployed);
    expect(fetch).toHaveBeenCalledWith(
      "/api/app-version",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    { ok: false },
    { ok: true, redirected: true },
    { ok: true, json: async () => ({ version: "2.21.7" }) },
    {
      ok: true,
      json: async () => {
        throw new Error("Invalid JSON");
      },
    },
  ])("rejects unsuccessful or invalid version responses", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(checkAppVersion()).rejects.toThrow();
  });

  it("recognizes releases and rebuilds, including a rollback deployment", () => {
    const current = { version: "2.21.6", buildId: "a" };
    expect(hasAppUpdate(current, current)).toBe(false);
    expect(hasAppUpdate(current, { ...current, buildId: "b" })).toBe(true);
    expect(hasAppUpdate(current, { version: "2.21.5", buildId: "older" })).toBe(true);
  });
});

describe("refreshInstalledApp", () => {
  it("updates the app worker and reloads while preserving push and local data", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const unregister = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: vi.fn().mockResolvedValue({ update, unregister }) },
    });
    const reload = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { reload } });
    window.localStorage.setItem("workspace-board-state:workspace:ws-1", "preserve-me");
    await refreshInstalledApp();
    expect(update).toHaveBeenCalledOnce();
    expect(unregister).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("workspace-board-state:workspace:ws-1")).toBe("preserve-me");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reports worker update failures without reloading", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: vi
          .fn()
          .mockResolvedValue({ update: vi.fn().mockRejectedValue(new Error("Offline")) }),
      },
    });
    const reload = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { reload } });
    await expect(refreshInstalledApp()).rejects.toThrow("Offline");
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads when service workers are unavailable", async () => {
    Reflect.deleteProperty(navigator, "serviceWorker");
    const reload = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { reload } });
    await refreshInstalledApp();
    expect(reload).toHaveBeenCalledOnce();
  });
});
