// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationListener } from "@/components/notification-listener";

const mocks = vi.hoisted(() => ({ push: vi.fn(), toast: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/push/sound", () => ({
  playNotificationSound: vi.fn().mockResolvedValue(undefined),
  unlockNotificationAudio: vi.fn().mockResolvedValue(undefined),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("notification client navigation", () => {
  function setup() {
    const worker = new EventTarget();
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
    render(<NotificationListener />);
    return worker;
  }
  it("acknowledges a worker request and navigates through the app router", () => {
    const worker = setup();
    const port = { postMessage: vi.fn() };
    act(() =>
      worker.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "hive:navigate", url: "/workspaces/w/terminal?session=review" },
          ports: [port as unknown as MessagePort],
        }),
      ),
    );
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/workspaces?session=review&workspace=w");
    expect(port.postMessage).toHaveBeenCalledWith({ type: "hive:navigated" });
  });
  it.each([
    "/workspaces/w/terminal?session=review&notification=e",
    "/workspaces?workspace=w&session=review&notification=e",
  ])("handles %s without route navigation", (url) => {
    const worker = setup();
    const focus = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener("hive:terminal-notification-focus", focus);
    act(() =>
      worker.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "hive:navigate",
            url,
          },
        }),
      ),
    );
    expect(focus).toHaveBeenCalledOnce();
    expect(mocks.push).not.toHaveBeenCalled();
    window.removeEventListener("hive:terminal-notification-focus", focus);
  });
  it.each([
    "https://evil.test/workspaces/w",
    "/login",
    "http://[",
  ])("rejects invalid navigation %s", (url) => {
    const worker = setup();
    act(() =>
      worker.dispatchEvent(new MessageEvent("message", { data: { type: "hive:navigate", url } })),
    );
    expect(mocks.push).not.toHaveBeenCalled();
  });
  it("uses client navigation for the toast Open action", () => {
    const worker = setup();
    act(() =>
      worker.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "hive:notification",
            payload: {
              kind: "ready",
              title: "Ready",
              body: "Done",
              url: "/workspaces/w/terminal?session=review",
            },
          },
        }),
      ),
    );
    mocks.toast.mock.calls[0][1].action.onClick();
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/workspaces?session=review&workspace=w");
  });
});
