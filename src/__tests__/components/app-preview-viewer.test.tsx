// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppPreviewViewer } from "@/components/app-preview-viewer";

const previewOrigin = "https://test-branch.hive-preview.kethalia.com";
const preview = {
  slug: "test-branch",
  title: "Preview",
  number: 12,
  branch: "test/branch",
  revision: "a".repeat(40),
};

beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(preview)),
  ),
);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shows the preview only after its exact frame reports readiness", async () => {
  render(<AppPreviewViewer preview={preview} />);
  const frame = await screen.findByTitle<HTMLIFrameElement>("Hive preview #12");
  expect(frame).toHaveAttribute("src", `${previewOrigin}/workspaces`);
  expect(frame).toHaveAttribute("inert");
  expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
  expect(screen.getByRole("link", { name: "Return to Hive" })).toHaveAttribute("href", "/settings");

  fireEvent(
    window,
    new MessageEvent("message", {
      data: "hive:preview-ready",
      source: frame.contentWindow,
      origin: "https://another-preview.hive-preview.kethalia.com",
    }),
  );
  fireEvent(
    window,
    new MessageEvent("message", {
      data: "hive:preview-ready",
      source: window,
      origin: previewOrigin,
    }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("Opening preview");

  fireEvent(
    window,
    new MessageEvent("message", {
      data: "hive:preview-ready",
      source: frame.contentWindow,
      origin: previewOrigin,
    }),
  );
  expect(frame).not.toHaveAttribute("inert");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("offers a direct link and retries with a fresh frame when the preview cannot load", async () => {
  vi.useFakeTimers();
  await act(async () => {
    render(<AppPreviewViewer preview={preview} />);
  });
  const original = screen.getByTitle("Hive preview #12");
  act(() => vi.advanceTimersByTime(20_000));
  expect(screen.getByRole("alert")).toHaveTextContent("Could not open this build");
  expect(screen.getByRole("link", { name: "Open in browser" })).toHaveAttribute(
    "href",
    `${previewOrigin}/workspaces`,
  );

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  });
  expect(screen.getByRole("status")).toHaveTextContent("Opening preview");
  expect(screen.getByTitle("Hive preview #12")).not.toBe(original);
});

it("keeps an outdated preview out of the iframe", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ...preview, revision: "b".repeat(40) })),
  );
  render(<AppPreviewViewer preview={preview} />);

  expect(await screen.findByRole("alert")).toHaveTextContent("Could not open this build");
  expect(screen.queryByTitle("Hive preview #12")).not.toBeInTheDocument();
});
