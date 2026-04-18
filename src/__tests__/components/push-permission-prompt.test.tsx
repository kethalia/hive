// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const mockGetVapidPublicKeyAction = vi.hoisted(() => vi.fn());
const mockSubscribePushAction = vi.hoisted(() => vi.fn());

vi.mock("@/lib/push/actions", () => ({
  getVapidPublicKeyAction: (...args: unknown[]) =>
    mockGetVapidPublicKeyAction(...args),
}));

vi.mock("@/lib/push/subscribe", () => ({
  subscribePushAction: (...args: unknown[]) =>
    mockSubscribePushAction(...args),
}));

import { PushPermissionPrompt } from "@/components/push-permission-prompt";

const mockLocalStorage: Record<string, string> = {};

beforeEach(() => {
  vi.clearAllMocks();

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

  Object.defineProperty(globalThis, "Notification", {
    value: {
      permission: "default" as NotificationPermission,
      requestPermission: vi.fn(),
    },
    writable: true,
    configurable: true,
  });

  Object.defineProperty(navigator, "serviceWorker", {
    value: {
      ready: Promise.resolve({
        pushManager: {
          subscribe: vi.fn(),
          getSubscription: vi.fn().mockResolvedValue(null),
        },
      }),
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  for (const key of Object.keys(mockLocalStorage)) {
    delete mockLocalStorage[key];
  }
});

describe("PushPermissionPrompt", () => {
  it("renders enable button when permission is default", async () => {
    render(<PushPermissionPrompt />);

    await waitFor(() => {
      expect(screen.getByText("Enable notifications")).toBeDefined();
    });
    expect(screen.getByText("Stay notified")).toBeDefined();
  });

  it("shows denied message when notifications are blocked", async () => {
    Object.defineProperty(globalThis.Notification, "permission", {
      value: "denied",
      writable: true,
      configurable: true,
    });

    render(<PushPermissionPrompt />);

    await waitFor(() => {
      expect(screen.getByText("Notifications blocked")).toBeDefined();
    });
    expect(
      screen.getByText(/blocked by your browser/)
    ).toBeDefined();
  });

  it("hides prompt when dismissed", async () => {
    const { unmount } = render(<PushPermissionPrompt />);

    await waitFor(() => {
      expect(screen.getByText("Enable notifications")).toBeDefined();
    });

    const dismissBtn = screen.getByLabelText("Dismiss notification prompt");
    fireEvent.click(dismissBtn);

    await waitFor(() => {
      expect(screen.queryByText("Enable notifications")).toBeNull();
    });
    expect(mockLocalStorage["push-prompt-dismissed"]).toBe("true");
    unmount();
  });

  it("renders nothing when permission is granted", async () => {
    Object.defineProperty(globalThis.Notification, "permission", {
      value: "granted",
      writable: true,
      configurable: true,
    });

    const { container } = render(<PushPermissionPrompt />);

    await waitFor(() => {
      expect(container.innerHTML).toBe("");
    });
  });

  it("stays hidden when previously dismissed", async () => {
    mockLocalStorage["push-prompt-dismissed"] = "true";

    const { container } = render(<PushPermissionPrompt />);

    await waitFor(() => {
      expect(container.querySelector("[role='alert']")).toBeNull();
    });
    expect(screen.queryByText("Enable notifications")).toBeNull();
  });
});
