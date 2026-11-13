// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeTemplatePush, pendingTemplatePush } from "@/lib/templates/push-request";

beforeEach(() => sessionStorage.clear());
describe("pending template publication identity", () => {
  it("persists before request and reuses identity after network/wake failures and module reload", async () => {
    const first = pendingTemplatePush("owner", "ai-dev-k8s");
    expect(first).toMatch(/^[a-f0-9-]{36}$/);
    expect(pendingTemplatePush("owner", "ai-dev-k8s")).toBe(first);
    vi.resetModules();
    const reloaded = await import("@/lib/templates/push-request");
    expect(reloaded.pendingTemplatePush("owner", "ai-dev-k8s")).toBe(first);
  });
  it("scopes pending requests by owner and template, and clears only the observed exact operation", () => {
    const a = pendingTemplatePush("owner-a", "ai-dev-k8s");
    const b = pendingTemplatePush("owner-b", "ai-dev-k8s");
    const other = pendingTemplatePush("owner-a", "browser-testing");
    expect(new Set([a, b, other]).size).toBe(3);
    completeTemplatePush("owner-b", "ai-dev-k8s", a);
    expect(pendingTemplatePush("owner-b", "ai-dev-k8s")).toBe(b);
    completeTemplatePush("owner-a", "ai-dev-k8s", a);
    const next = pendingTemplatePush("owner-a", "ai-dev-k8s");
    expect(next).not.toBe(a);
    completeTemplatePush("owner-a", "ai-dev-k8s", a);
    expect(pendingTemplatePush("owner-a", "ai-dev-k8s")).toBe(next);
  });
});
