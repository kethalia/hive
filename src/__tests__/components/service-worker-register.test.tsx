// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

describe("ServiceWorkerRegister", () => {
  const registerMock = vi.fn(() => Promise.resolve({} as ServiceWorkerRegistration));

  beforeEach(() => {
    vi.resetModules();
    registerMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("registers /sw.js on mount when serviceWorker is available", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerMock },
      configurable: true,
      writable: true,
    });

    const { ServiceWorkerRegister } = await import(
      "@/components/service-worker-register"
    );
    const { container } = render(<ServiceWorkerRegister />);

    expect(registerMock).toHaveBeenCalledWith("/sw.js");
    expect(container.innerHTML).toBe("");
  });

  it("handles missing serviceWorker API gracefully", async () => {
    // @ts-expect-error — removing property to simulate missing API
    delete navigator.serviceWorker;

    const { ServiceWorkerRegister } = await import(
      "@/components/service-worker-register"
    );

    expect(() => render(<ServiceWorkerRegister />)).not.toThrow();
    expect(registerMock).not.toHaveBeenCalled();
  });
});
