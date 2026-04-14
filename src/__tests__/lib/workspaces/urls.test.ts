import { describe, it, expect } from "vitest";
import { buildWorkspaceUrls } from "@/lib/workspaces/urls";

describe("buildWorkspaceUrls", () => {
  const workspace = { name: "dev-box", owner_name: "alice" };
  const agent = "main";

  it("builds correct filebrowser, kasmvnc, and dashboard URLs", () => {
    const urls = buildWorkspaceUrls(workspace, agent, "https://coder.example.com");

    expect(urls.filebrowser).toBe(
      "https://filebrowser--main--dev-box--alice.coder.example.com",
    );
    expect(urls.kasmvnc).toBe(
      "https://kasmvnc--main--dev-box--alice.coder.example.com",
    );
    expect(urls.dashboard).toBe("https://coder.example.com/@alice/dev-box");
  });

  it("strips trailing slash from CODER_URL", () => {
    const urls = buildWorkspaceUrls(workspace, agent, "https://coder.example.com/");

    expect(urls.filebrowser).toBe(
      "https://filebrowser--main--dev-box--alice.coder.example.com",
    );
    expect(urls.dashboard).toBe("https://coder.example.com/@alice/dev-box");
  });

  it("strips multiple trailing slashes", () => {
    const urls = buildWorkspaceUrls(workspace, agent, "https://coder.example.com///");

    expect(urls.dashboard).toBe("https://coder.example.com/@alice/dev-box");
  });

  it("handles CODER_URL with path prefix", () => {
    const urls = buildWorkspaceUrls(workspace, agent, "https://proxy.example.com/coder");

    expect(urls.filebrowser).toBe(
      "https://filebrowser--main--dev-box--alice.proxy.example.com/coder",
    );
    expect(urls.dashboard).toBe("https://proxy.example.com/coder/@alice/dev-box");
  });

  it("uses the provided agent name in subdomain URLs", () => {
    const urls = buildWorkspaceUrls(workspace, "gpu-agent", "https://coder.dev");

    expect(urls!.filebrowser).toBe(
      "https://filebrowser--gpu-agent--dev-box--alice.coder.dev",
    );
    expect(urls!.kasmvnc).toBe(
      "https://kasmvnc--gpu-agent--dev-box--alice.coder.dev",
    );
  });

  it("returns null for empty coderUrl", () => {
    const urls = buildWorkspaceUrls(workspace, agent, "");
    expect(urls).toBeNull();
  });
});
