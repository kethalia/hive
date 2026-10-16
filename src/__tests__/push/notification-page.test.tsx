import { beforeEach, describe, expect, it, vi } from "vitest";
import TerminalPage from "@/app/(dashboard)/workspaces/[id]/terminal/page";
import { StaleEntryAlert } from "@/app/(dashboard)/workspaces/[id]/terminal/stale-entry-alert";
import { TerminalClient } from "@/app/(dashboard)/workspaces/[id]/terminal/terminal-client";
import { NotificationTerminalLink } from "@/components/terminal/NotificationTerminalLink";

const mocks = vi.hoisted(() => ({ agent: vi.fn() }));
vi.mock("@/lib/actions/workspaces", () => ({ getWorkspaceAgentAction: mocks.agent }));
vi.mock("@/components/terminal/NotificationTerminalLink", () => ({
  NotificationTerminalLink: () => null,
}));
vi.mock("@/app/(dashboard)/workspaces/[id]/terminal/terminal-client", () => ({
  TerminalClient: () => null,
}));
vi.mock("@/app/(dashboard)/workspaces/[id]/terminal/stale-entry-alert", () => ({
  StaleEntryAlert: () => null,
}));

beforeEach(() => {
  mocks.agent.mockResolvedValue({ data: { agentId: "a", agentStatus: "connected" } });
});
describe("notification entry page", () => {
  it.each([
    { session: "dev", notification: "event-1" },
    { session: `git-clone-${"a".repeat(32)}` },
  ])("resolves both new and old notification links before mounting a terminal", async (query) => {
    const page = await TerminalPage({
      params: Promise.resolve({ id: "w" }),
      searchParams: Promise.resolve(query),
    });
    expect(page.type).toBe(NotificationTerminalLink);
    expect(page.props).toMatchObject({
      workspaceId: "w",
      agentId: "a",
      sessionName: query.session,
    });
  });
  it("retains the normal entry flow for an authorized standalone terminal", async () => {
    const page = await TerminalPage({
      params: Promise.resolve({ id: "w" }),
      searchParams: Promise.resolve({
        session: `git-clone-${"a".repeat(32)}`,
        cloneProof: "fresh-proof",
      }),
    });
    expect(page.props.children.type).toBe(TerminalClient);
  });
  it("checks workspace access before resolving a notification", async () => {
    mocks.agent.mockResolvedValue({ serverError: "Not authenticated" });
    const page = await TerminalPage({
      params: Promise.resolve({ id: "w" }),
      searchParams: Promise.resolve({ session: "dev", notification: "event-1" }),
    });
    expect(page.type).toBe(StaleEntryAlert);
  });
});
