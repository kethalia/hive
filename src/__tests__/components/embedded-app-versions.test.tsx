// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://codex-task.hive-preview.kethalia.com/settings"}

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LoginHomeLink } from "@/app/login/login-home-link";
import { AppPreviewVersions } from "@/components/app-preview-versions";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("switches to Production from the preview version picker", () => {
  const postMessage = vi.fn();
  vi.spyOn(window, "parent", "get").mockReturnValue({ postMessage } as unknown as Window);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);

  render(<AppPreviewVersions />);
  const details = screen.getByText("Versions", { exact: true }).closest("details");
  if (!details) throw new Error("Versions disclosure missing");
  details.open = true;
  fireEvent(details, new Event("toggle"));
  fireEvent.click(screen.getByRole("button", { name: "Production" }));

  expect(postMessage).toHaveBeenCalledExactlyOnceWith(
    "hive:switch-to-production",
    "https://hive.kethalia.com",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("can return to Production from the preview sign-in screen", () => {
  const postMessage = vi.fn();
  vi.spyOn(window, "parent", "get").mockReturnValue({ postMessage } as unknown as Window);

  render(<LoginHomeLink />);
  fireEvent.click(screen.getByRole("link", { name: "Return to production" }));

  expect(postMessage).toHaveBeenCalledExactlyOnceWith(
    "hive:switch-to-production",
    "https://hive.kethalia.com",
  );
});
