import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DELETE,
  GET,
  HEAD,
  OPTIONS,
  PATCH,
  POST,
  PUT,
} from "@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route";

afterEach(() => vi.restoreAllMocks());

describe("retired workspace proxy", () => {
  it.each([
    ["GET", GET],
    ["HEAD", HEAD],
    ["POST", POST],
    ["PUT", PUT],
    ["PATCH", PATCH],
    ["DELETE", DELETE],
    ["OPTIONS", OPTIONS],
  ] as const)("returns inert content for %s without forwarding requests or credentials", async (_method, handler) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = handler();
    expect(response.status).toBe(410);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("permissions-policy")).toContain("microphone=()");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("location")).toBe(false);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect((await response.json()).error).toContain("Workspace proxy retired");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
