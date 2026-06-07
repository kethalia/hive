// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshInstalledApp } from "@/lib/app-update";

describe("refreshInstalledApp", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates and unregisters service workers, clears Cache Storage, and reloads", async () => {
    const update = vi.fn(() => Promise.resolve());
    const unregister = vi.fn(() => Promise.resolve(true));
    const getRegistrations = vi.fn(() => Promise.resolve([{ update, unregister }]));
    const cacheKeys = vi.fn(() => Promise.resolve(["old-app-shell", "old-static-chunks"]));
    const cacheDelete = vi.fn(() => Promise.resolve(true));
    const reload = vi.fn();

    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistrations },
    });
    Object.defineProperty(window, "caches", {
      configurable: true,
      value: { keys: cacheKeys, delete: cacheDelete },
    });
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { reload },
    });

    window.localStorage.setItem("workspace-board-state:workspace:ws-1", "preserve-me");

    await refreshInstalledApp();

    expect(getRegistrations).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(cacheKeys).toHaveBeenCalledTimes(1);
    expect(cacheDelete).toHaveBeenCalledWith("old-app-shell");
    expect(cacheDelete).toHaveBeenCalledWith("old-static-chunks");
    expect(window.localStorage.getItem("workspace-board-state:workspace:ws-1")).toBe("preserve-me");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("still reloads when update, unregister, and Cache Storage cleanup fail", async () => {
    const update = vi.fn(() => Promise.reject(new Error("update failed")));
    const unregister = vi.fn(() => Promise.reject(new Error("unregister failed")));
    const getRegistrations = vi.fn(() => Promise.resolve([{ update, unregister }]));
    const cacheKeys = vi.fn(() => Promise.reject(new Error("cache list failed")));
    const reload = vi.fn();

    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistrations },
    });
    Object.defineProperty(window, "caches", {
      configurable: true,
      value: { keys: cacheKeys, delete: vi.fn() },
    });
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { reload },
    });

    await refreshInstalledApp();

    expect(getRegistrations).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(cacheKeys).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("still reloads when service workers and Cache Storage are unavailable", async () => {
    const reload = vi.fn();

    // @ts-expect-error - deleting browser APIs to simulate an unsupported environment.
    delete navigator.serviceWorker;
    // @ts-expect-error - deleting browser APIs to simulate an unsupported environment.
    delete window.caches;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { reload },
    });

    await refreshInstalledApp();

    expect(reload).toHaveBeenCalledTimes(1);
  });
});
