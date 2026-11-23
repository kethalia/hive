// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://hive.kethalia.com/settings"}

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppPreviewVersions } from "@/components/app-preview-versions";

const entries = [
  {
    slug: "codex-task",
    number: 458,
    title: "Managed task",
    branch: "codex/task",
    revision: "a".repeat(40),
  },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([
  { responseStatus: 503, retain: true },
  { responseStatus: 401, retain: false },
  { responseStatus: 403, retain: false },
])("handles a preview refresh failure with status $responseStatus", async ({
  responseStatus,
  retain,
}) => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(entries))
    .mockResolvedValueOnce(new Response(null, { status: responseStatus }));
  vi.stubGlobal("fetch", fetch);
  render(<AppPreviewVersions />);

  const details = screen.getByText("Preview versions").closest("details");
  if (!details) throw new Error("Preview disclosure missing");
  details.open = true;
  fireEvent(details, new Event("toggle"));
  const label = /#458 Managed task/;
  expect(await screen.findByRole("link", { name: label })).toHaveAttribute(
    "href",
    "/app-preview/codex-task",
  );

  fireEvent.click(screen.getByRole("button", { name: "Refresh previews" }));
  expect(screen.getByRole("button", { name: "Refreshing previews…" })).toBeDisabled();
  expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load preview versions");
  expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  if (retain) expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
  else expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
});
