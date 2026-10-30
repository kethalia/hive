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
