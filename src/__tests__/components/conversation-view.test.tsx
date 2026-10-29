// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationView } from "@/components/projects/ConversationView";
import type { SessionView } from "@/lib/codex-session/adapter";

afterEach(cleanup);
const view = (): SessionView => ({
  phase: "live",
  needsRefresh: false,
  error: null,
  turns: [
    {
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      items: [
        { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Please fix this" }] },
        { id: "agent-1", type: "agentMessage", text: "<script>unsafe()</script>" },
        {
          id: "command-1",
          type: "commandExecution",
          command: "pnpm test",
          aggregatedOutput: "Tests passed",
          status: "completed",
          exitCode: 0,
        },
      ],
    },
  ],
});
function props() {
  return { sessionKey: "session-a", view: view(), onReconnect: vi.fn(), onOpenTerminal: vi.fn() };
}

describe("native conversation view", () => {
  it("renders native roles and output as escaped text", () => {
    const { container } = render(<ConversationView {...props()} />);
    expect(screen.getByRole("article", { name: "Your message" }).textContent).toContain(
      "Please fix this",
    );
    expect(screen.getByRole("article", { name: "Codex message" }).textContent).toContain(
      "<script>unsafe()</script>",
    );
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("Tests passed")).toBeTruthy();
    expect(container.querySelector("details")?.open).toBe(false);
  });
  it("switches to terminal only when requested and never starts an agent", () => {
    const value = props();
    render(<ConversationView {...value} />);
    expect(value.onOpenTerminal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue in Terminal" }));
    expect(value.onOpenTerminal).toHaveBeenCalledTimes(1);
  });
  it("keeps errors generic and offers reconnect", () => {
    const value = props();
    value.view.error = "raw secret-bearing transport error";
    value.view.phase = "error";
    render(<ConversationView {...value} />);
    expect(screen.getByRole("alert").textContent).not.toContain("secret-bearing");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(value.onReconnect).toHaveBeenCalledTimes(1);
  });
  it("keeps unsupported activity visible without rendering arbitrary payloads", () => {
    const value = props();
    value.view.turns[0].items.push({ id: "future", type: "unknown", unsupported: true });
    render(<ConversationView {...value} />);
    expect(screen.getByText("This activity is available in Terminal.")).toBeTruthy();
  });
  it("bounds initial history and resets expanded history for another session", () => {
    const value = props();
    value.view.turns = Array.from({ length: 80 }, (_, i) => ({
      id: `turn-${i}`,
      status: "completed" as const,
      itemsView: "full" as const,
      items: [{ id: `item-${i}`, type: "agentMessage", text: `Message ${i}` }],
    }));
    const { rerender } = render(<ConversationView {...value} />);
    expect(screen.getAllByRole("article")).toHaveLength(40);
    fireEvent.click(screen.getByRole("button", { name: "Show earlier activity (40 turns)" }));
    expect(screen.getAllByRole("article")).toHaveLength(80);
    rerender(<ConversationView {...value} sessionKey="session-b" />);
    expect(screen.getAllByRole("article")).toHaveLength(40);
  });
  it("does not pull a reader back to the bottom when new text arrives", () => {
    const value = props();
    const { rerender } = render(<ConversationView {...value} />);
    const region = screen.getByRole("region", { name: "Conversation history" });
    Object.defineProperties(region, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 200, configurable: true },
    });
    region.scrollTop = 100;
    fireEvent.scroll(region);
    const next = view();
    next.turns[0].items[1].text = "A streamed update";
    rerender(<ConversationView {...value} view={next} />);
    expect(region.scrollTop).toBe(100);
    fireEvent.click(screen.getByRole("button", { name: "Latest activity" }));
    expect(region.scrollTop).toBe(1000);
  });
});
