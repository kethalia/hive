// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetVapidPublicKeyAction = vi.hoisted(() => vi.fn());
const mockSubscribePushAction = vi.hoisted(() => vi.fn());

vi.mock("@/lib/push/actions", () => ({
  getVapidPublicKeyAction: (...args: unknown[]) => mockGetVapidPublicKeyAction(...args),
}));

vi.mock("@/lib/push/subscribe", () => ({
  subscribePushAction: (...args: unknown[]) => mockSubscribePushAction(...args),
}));

import { PushPermissionPrompt } from "@/components/push-permission-prompt";

const mockLocalStorage: Record<string, string> = {};

const fakePushSubscription = {
  endpoint: "https://push.example.test/subscriptions/secret-endpoint",
  expirationTime: null,
  options: {
    applicationServerKey: null,
    userVisibleOnly: true,
  },
  getKey: vi.fn((_name: PushEncryptionKeyName) => new ArrayBuffer(0)),
  unsubscribe: vi.fn(async () => true),
  toJSON: () => ({
    endpoint: "https://push.example.test/subscriptions/secret-endpoint",
    expirationTime: null,
    keys: {
      p256dh: "secret-p256dh-key",
      auth: "secret-auth-key",
    },
  }),
} satisfies PushSubscription;

const mockPushManager = {
  subscribe: vi.fn(),
  getSubscription: vi.fn(),
};

function setNotificationPermission(permission: NotificationPermission) {
  Object.defineProperty(globalThis.Notification, "permission", {
    value: permission,
    writable: true,
    configurable: true,
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

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

  mockGetVapidPublicKeyAction.mockResolvedValue({ data: { publicKey: "AQID" } });
  mockSubscribePushAction.mockResolvedValue({ data: { success: true } });
  mockPushManager.subscribe.mockResolvedValue(fakePushSubscription);
  mockPushManager.getSubscription.mockResolvedValue(null);

  Object.defineProperty(navigator, "serviceWorker", {
    value: {
      ready: Promise.resolve({
        pushManager: mockPushManager,
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

  it("shows denied message with dismiss and retry actions when notifications are blocked", async () => {
    setNotificationPermission("denied");

    render(<PushPermissionPrompt />);

    await waitFor(() => {
      expect(screen.getByText("Notifications blocked")).toBeDefined();
    });
    expect(screen.getByText(/blocked by your browser/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });

  it("hides default prompt when dismissed", async () => {
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

  it("dismisses the denied prompt and persists the prompt dismissal key", async () => {
    setNotificationPermission("denied");

    render(<PushPermissionPrompt />);

    await waitFor(() => {
      expect(screen.getByText("Notifications blocked")).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => {
      expect(screen.queryByText("Notifications blocked")).toBeNull();
    });
    expect(mockLocalStorage["push-prompt-dismissed"]).toBe("true");
  });

  it("keeps the blocked prompt visible on retry when permission is still denied without requesting permission or subscribing", async () => {
    setNotificationPermission("denied");

    render(<PushPermissionPrompt />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.getByText(/Notifications are still blocked/)).toBeDefined();
    });
    expect(screen.getByText("Notifications blocked")).toBeDefined();
    expect(globalThis.Notification.requestPermission).not.toHaveBeenCalled();
    expect(mockPushManager.subscribe).not.toHaveBeenCalled();
    expect(mockSubscribePushAction).not.toHaveBeenCalled();
  });

  it("subscribes and hides the blocked prompt on retry when permission has become granted", async () => {
    setNotificationPermission("denied");

    render(<PushPermissionPrompt />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    });

    setNotificationPermission("granted");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(mockSubscribePushAction).toHaveBeenCalledWith({
        endpoint: fakePushSubscription.endpoint,
        p256dh: "secret-p256dh-key",
        auth: "secret-auth-key",
      });
    });
    expect(mockGetVapidPublicKeyAction).toHaveBeenCalledTimes(1);
    expect(mockPushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: expect.any(Uint8Array),
    });
    expect(globalThis.Notification.requestPermission).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByText("Notifications blocked")).toBeNull();
    });
  });

  it("disables retry while granted retry subscription is in flight", async () => {
    const pendingSubscribe = createDeferred<{ data: { success: true } }>();
    mockSubscribePushAction.mockReturnValue(pendingSubscribe.promise);
    setNotificationPermission("denied");

    render(<PushPermissionPrompt />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    });

    setNotificationPermission("granted");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      const retryingButton = screen.getByRole("button", { name: "Retrying…" });
      expect((retryingButton as HTMLButtonElement).disabled).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Retrying…" }));
    expect(mockSubscribePushAction).toHaveBeenCalledTimes(1);

    pendingSubscribe.resolve({ data: { success: true } });
    await waitFor(() => {
      expect(screen.queryByText("Notifications blocked")).toBeNull();
    });
  });

  it("keeps sanitized retryable copy visible without claiming notifications are blocked when granted retry subscription fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const secretFailure = new Error(
      `Subscription failed for ${fakePushSubscription.endpoint} secret-p256dh-key secret-auth-key`,
    );
    mockSubscribePushAction.mockRejectedValue(secretFailure);
    setNotificationPermission("denied");

    render(<PushPermissionPrompt />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    });

    setNotificationPermission("granted");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.getByText(/We could not restore notifications/)).toBeDefined();
    });
    expect(screen.getByText("Notifications unavailable")).toBeDefined();
    expect(screen.queryByText("Notifications blocked")).toBeNull();
    const visibleCopy = document.body.textContent ?? "";
    expect(visibleCopy).not.toContain(fakePushSubscription.endpoint);
    expect(visibleCopy).not.toContain("secret-p256dh-key");
    expect(visibleCopy).not.toContain("secret-auth-key");
    expect(consoleError).toHaveBeenCalledWith("[push] Retry subscribe failed:", secretFailure);
    consoleError.mockRestore();
  });

  it("returns to the default prompt on retry when browser permission is no longer denied but still default", async () => {
    setNotificationPermission("denied");

    render(<PushPermissionPrompt />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    });

    setNotificationPermission("default");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.getByText("Stay notified")).toBeDefined();
    });
    expect(screen.getByText("Enable notifications")).toBeDefined();
    expect(globalThis.Notification.requestPermission).not.toHaveBeenCalled();
    expect(mockSubscribePushAction).not.toHaveBeenCalled();
  });

  it("renders nothing when permission is granted", async () => {
    setNotificationPermission("granted");

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

  it("keeps denied prompt hidden when previously dismissed", async () => {
    mockLocalStorage["push-prompt-dismissed"] = "true";
    setNotificationPermission("denied");

    const { container } = render(<PushPermissionPrompt />);

    await waitFor(() => {
      expect(container.querySelector("[role='alert']")).toBeNull();
    });
    expect(screen.queryByText("Notifications blocked")).toBeNull();
  });
});
