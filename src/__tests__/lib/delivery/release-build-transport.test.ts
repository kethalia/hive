import { expect, it } from "vitest";
import { isReleaseBuildTransport } from "@/lib/delivery/release-build-transport";

it("admits only exact enabled machine POSTs to the OIDC-verifying routes", () => {
  const req = (path: string, headers: Record<string, string> = {}) =>
    new Request(`https://example.test${path}`, {
      method: "POST",
      headers: { "x-hive-release-oidc": "a.b.c", ...headers },
    });
  expect(isReleaseBuildTransport(req("/api/internal/release-build/challenge"), "true")).toBe(true);
  expect(isReleaseBuildTransport(req("/api/internal/release-build/attestation"), "true")).toBe(
    true,
  );
  expect(isReleaseBuildTransport(req("/api/internal/release-build/challenge"), undefined)).toBe(
    false,
  );
  expect(isReleaseBuildTransport(req("/api/internal/release-build/challenge?x=1"), "true")).toBe(
    false,
  );
  expect(
    isReleaseBuildTransport(
      req("/api/internal/release-build/challenge", { origin: "https://example.test" }),
      "true",
    ),
  ).toBe(false);
  expect(
    isReleaseBuildTransport(
      req("/api/internal/release-build/challenge", { "content-length": "32769" }),
      "true",
    ),
  ).toBe(false);
  expect(isReleaseBuildTransport(req("/api/internal/release-build/other"), "true")).toBe(false);
  for (const path of [
    "/api/internal/release-tested/challenge",
    "/api/internal/release-tested/attestation",
  ]) {
    expect(isReleaseBuildTransport(req(path), "true")).toBe(false);
    expect(isReleaseBuildTransport(req(path), "true", "true")).toBe(true);
    expect(
      isReleaseBuildTransport(req(path, { origin: "https://example.test" }), "true", "true"),
    ).toBe(false);
  }
});
