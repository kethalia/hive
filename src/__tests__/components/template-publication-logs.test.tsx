// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TemplatePublicationLogs } from "@/components/templates/TemplatePublicationLogs";

const jobId = "11111111-1111-4111-8111-111111111111";
const page = (output: string, patch: Record<string, unknown> = {}) => ({
  records: [{ id: "1", output }],
  nextAfter: "1",
  hasMore: false,
  fallback: null,
  available: true,
  stage: "succeeded",
  coderUrl: "https://coder.fixture.invalid/templates/default/ai-dev-k8s/versions/fixed",
  viewScope: "a".repeat(64),
  ...patch,
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
describe("explicit detailed template log view", () => {
  it("fetches only on explicit action and renders raw output as escaped plain text", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(page('<script>alert("x")</script>\u001b[31m control')),
    );
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(<TemplatePublicationLogs name="ai-dev-k8s" jobId={jobId} />);
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View detailed logs" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Import log output" }).textContent).toContain(
        "<script>",
      ),
    );
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByRole("region", { name: "Import log output" }).textContent).not.toContain(
      "\u001b",
    );
    expect(screen.getByRole("link", { name: "Open logs in Coder" }).getAttribute("href")).toBe(
      page("").coderUrl,
    );
    expect(fetcher.mock.calls).toHaveLength(1);
  });
  it("pages only from a validated cursor; malformed/oversized rows offer the fixed link and cannot be skipped", async () => {
    let count = 0;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(
        ++count === 1
          ? page("first", { hasMore: true })
          : page("", { records: [], nextAfter: "1", hasMore: true, fallback: "row_too_large" }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    render(<TemplatePublicationLogs name="ai-dev-k8s" jobId={jobId} />);
    fireEvent.click(screen.getByRole("button", { name: "View detailed logs" }));
    await screen.findByText("first");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText(/could not be displayed safely/);
    expect(fetcher.mock.calls[1]?.[0]).toContain("after=1");
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
  it("permission failure clears prior output and does not expose an error body", async () => {
    let count = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ++count === 1
          ? Response.json(page("private previous data"))
          : new Response("secret error body", { status: 403 }),
      ),
    );
    render(<TemplatePublicationLogs name="ai-dev-k8s" jobId={jobId} />);
    fireEvent.click(screen.getByRole("button", { name: "View detailed logs" }));
    await screen.findByText("private previous data");
    fireEvent.click(screen.getByRole("button", { name: "Refresh page" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("private previous data")).toBeNull();
    expect(screen.queryByText("secret error body")).toBeNull();
  });
  it("close, hidden page and task change erase memory display; late response cannot reopen it", async () => {
    let release!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    const { rerender } = render(<TemplatePublicationLogs name="ai-dev-k8s" jobId={jobId} />);
    fireEvent.click(screen.getByRole("button", { name: "View detailed logs" }));
    fireEvent.click(screen.getByRole("button", { name: "Close logs" }));
    release(Response.json(page("late private output")));
    await Promise.resolve();
    expect(screen.queryByText("late private output")).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(page("visible private"))),
    );
    fireEvent.click(screen.getByRole("button", { name: "View detailed logs" }));
    await screen.findByText("visible private");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.queryByText("visible private")).toBeNull();
    rerender(
      <TemplatePublicationLogs
        name="browser-testing"
        jobId="22222222-2222-4222-8222-222222222222"
      />,
    );
    expect(screen.getByRole("button", { name: "View detailed logs" })).toBeDefined();
    expect(screen.queryByText("visible private")).toBeNull();
  });
});
