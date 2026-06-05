// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PwaInstallPrompt } from "@/components/pwa-install-prompt";

const mockLocalStorage: Record<string, string> = {};

function installMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
    writable: true,
    configurable: true,
  });
}

function installLocalStorage() {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => mockLocalStorage[key] ?? null,
      setItem: (key: string, val: string) => {
        mockLocalStorage[key] = val;
      },
      removeItem: (key: string) => {
        delete mockLocalStorage[key];
      },
    },
    writable: true,
    configurable: true,
  });
}

type TestBeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

beforeEach(() => {
  vi.clearAllMocks();
  installLocalStorage();
  installMatchMedia(false);
});

afterEach(() => {
  cleanup();
  for (const key of Object.keys(mockLocalStorage)) {
    delete mockLocalStorage[key];
  }
});

describe("PwaInstallPrompt", () => {
  it("shows browser-specific install instructions when native install prompt is unavailable", async () => {
    render(<PwaInstallPrompt />);

    expect(await screen.findByText("Install Hive as an app")).toBeDefined();
    expect(screen.getByText(/Chrome or Edge → Install app/)).toBeDefined();
    expect(screen.getByText(/Safari on macOS → File → Add to Dock/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Install app" })).toBeNull();
  });

  it("uses beforeinstallprompt to provide a native install button", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const installEvent = new Event("beforeinstallprompt", {
      cancelable: true,
    }) as TestBeforeInstallPromptEvent;
    installEvent.prompt = prompt;
    installEvent.userChoice = Promise.resolve({ outcome: "accepted", platform: "web" });
    const preventDefault = vi.spyOn(installEvent, "preventDefault");

    render(<PwaInstallPrompt />);
    await screen.findByText("Install Hive as an app");

    window.dispatchEvent(installEvent);

    const installButton = await screen.findByRole("button", { name: "Install app" });
    expect(preventDefault).toHaveBeenCalledTimes(1);

    fireEvent.click(installButton);

    await waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByText("Install Hive as an app")).toBeNull();
    });
    expect(mockLocalStorage["hive:pwa-install-prompt-dismissed"]).toBe("true");
  });

  it("persists dismissal", async () => {
    render(<PwaInstallPrompt />);

    await screen.findByText("Install Hive as an app");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss install app prompt" }));

    await waitFor(() => {
      expect(screen.queryByText("Install Hive as an app")).toBeNull();
    });
    expect(mockLocalStorage["hive:pwa-install-prompt-dismissed"]).toBe("true");
  });

  it("hides when running as an installed app", async () => {
    installMatchMedia(true);

    const { container } = render(<PwaInstallPrompt />);

    await waitFor(() => {
      expect(container.innerHTML).toBe("");
    });
  });
});
