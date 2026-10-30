import { describe, expect, it } from "vitest";
import { isPortableTemplatePublication } from "../../../../deploy/cloudflare/app/template-publications";

const origin = "https://preview.example",
  path = "/api/templates/ai-dev-k8s/push",
  stream = `${path}/00000000-0000-4000-8000-000000000001/stream`;
const request = (value = path, method = "POST", headers = {}) =>
  new Request(origin + value, { method, headers });

describe("portable template publication transport", () => {
  it("requires activation and exact method/known template/job route", () => {
    for (const flag of [undefined, "false", "TRUE"])
      expect(isPortableTemplatePublication(request(), flag)).toBe(false);
    expect(isPortableTemplatePublication(request(), "true")).toBe(true);
    expect(isPortableTemplatePublication(request(stream, "GET"), "true")).toBe(true);
    expect(isPortableTemplatePublication(request(path, "GET"), "true")).toBe(false);
    expect(isPortableTemplatePublication(request(stream, "POST"), "true")).toBe(false);
  });
  it.each([
    "/api/templates/status",
    "/api/templates/custom/push",
    `${path}/`,
    `${path}?`,
    `${path}?activate=true`,
    `${path}/other`,
    `${path}/not-a-job/stream`,
    "/api/templates/%61i-dev-k8s/push",
    `${stream}/`,
    `${stream}?after=1`,
  ])("keeps neighboring or encoded routes private: %s", (value) => {
    expect(isPortableTemplatePublication(request(value), "true")).toBe(false);
    expect(isPortableTemplatePublication(request(value, "GET"), "true")).toBe(false);
  });
  it("does not permit server-action or upgraded requests", () => {
    for (const headers of [{ "Next-Action": "anything" }, { Upgrade: "websocket" }])
      expect(isPortableTemplatePublication(request(path, "POST", headers), "true")).toBe(false);
  });
});

describe("portable template log transport", () => {
  const logs = stream.replace(/stream$/, "logs");
  it("permits independently enabled historical reads and bounded canonical cursors", () => {
    for (const suffix of ["", "?after=0", "?after=1", "?after=9223372036854775807"])
      expect(isPortableTemplatePublication(request(logs + suffix, "GET"), "false", "true")).toBe(
        true,
      );
    expect(isPortableTemplatePublication(request(logs, "GET"), "true")).toBe(false);
    expect(isPortableTemplatePublication(request(logs, "POST"), "true", "true")).toBe(false);
  });
  it.each([
    "?",
    "?after=",
    "?after=-1",
    "?after=01",
    "?after=9223372036854775808",
    "?after=1&after=2",
    "?after=%31",
    "?%61fter=1",
    "?limit=1",
    "/",
    "?after=1&",
    "?after=1e3",
  ])("rejects ambiguous or out-of-range query %s", (suffix) => {
    expect(isPortableTemplatePublication(request(logs + suffix, "GET"), "true", "true")).toBe(
      false,
    );
  });
  it("retains exact template/path and rejects action or upgrade headers", () => {
    for (const value of [
      logs.replace("ai-dev-k8s", "custom"),
      logs.replace("ai-dev-k8s", "%61i-dev-k8s"),
      logs.replace("00000000", "ABCDEFGH"),
    ])
      expect(isPortableTemplatePublication(request(value, "GET"), "true", "true")).toBe(false);
    for (const headers of [{ "Next-Action": "anything" }, { Upgrade: "websocket" }])
      expect(isPortableTemplatePublication(request(logs, "GET", headers), "true", "true")).toBe(
        false,
      );
  });
});
