import { describe, expect, it } from "vitest";
import {
  buildCodeServerFolderUrl,
  buildFileBrowserFolderUrl,
  buildWorkspaceUrls,
} from "@/lib/workspaces/urls";

describe("buildWorkspaceUrls", () => {
  const workspace = { name: "dev-box", owner_name: "alice" };
  const agent = "main";

  it("builds correct subdomain filebrowser, kasmvnc, codeServer, and dashboard URLs", () => {
    const urls = buildWorkspaceUrls(workspace, agent, "https://coder.example.com");

    expect(urls!.filebrowser).toBe("https://filebrowser--main--dev-box--alice.coder.example.com");
    expect(urls!.kasmvnc).toBe("https://kasm-vnc--main--dev-box--alice.coder.example.com");
    expect(urls!.codeServer).toBe("https://code-server--main--dev-box--alice.coder.example.com");
    expect(urls!.dashboard).toBe("https://coder.example.com/@alice/dev-box");
  });

  it("strips trailing slash from CODER_URL", () => {
    const urls = buildWorkspaceUrls(workspace, agent, "https://coder.example.com/");

    expect(urls!.filebrowser).toBe("https://filebrowser--main--dev-box--alice.coder.example.com");
    expect(urls!.dashboard).toBe("https://coder.example.com/@alice/dev-box");
  });

  it("strips multiple trailing slashes", () => {
    const urls = buildWorkspaceUrls(workspace, agent, "https://coder.example.com///");

    expect(urls!.dashboard).toBe("https://coder.example.com/@alice/dev-box");
  });

  it("preserves HTTP for non-TLS Coder workspace applications", () => {
    const urls = buildWorkspaceUrls(workspace, agent, "http://localhost:7080", "*.localhost:7080");

    expect(urls!.filebrowser).toBe("http://filebrowser--main--dev-box--alice.localhost:7080");
    expect(urls!.kasmvnc).toBe("http://kasm-vnc--main--dev-box--alice.localhost:7080");
    expect(urls!.codeServer).toBe("http://code-server--main--dev-box--alice.localhost:7080");
    expect(urls!.dashboard).toBe("http://localhost:7080/@alice/dev-box");
  });

  it("uses the provided agent name in subdomain URLs", () => {
    const urls = buildWorkspaceUrls(workspace, "gpu-agent", "https://coder.dev");

    expect(urls!.filebrowser).toBe("https://filebrowser--gpu-agent--dev-box--alice.coder.dev");
    expect(urls!.kasmvnc).toBe("https://kasm-vnc--gpu-agent--dev-box--alice.coder.dev");
    expect(urls!.codeServer).toBe("https://code-server--gpu-agent--dev-box--alice.coder.dev");
  });

  it("uses Coder's configured wildcard app host when it differs from the access URL", () => {
    const urls = buildWorkspaceUrls(
      workspace,
      agent,
      "https://coder.kethalia.com",
      "*.kethalia.com",
    );

    expect(urls!.filebrowser).toBe("https://filebrowser--main--dev-box--alice.kethalia.com");
    expect(urls!.codeServer).toBe("https://code-server--main--dev-box--alice.kethalia.com");
    expect(urls!.dashboard).toBe("https://coder.kethalia.com/@alice/dev-box");
  });

  it("preserves suffix-style wildcard app hosts", () => {
    const urls = buildWorkspaceUrls(
      workspace,
      agent,
      "https://coder.example.com",
      "*--suffix.au.example.com",
    );

    expect(urls!.filebrowser).toBe(
      "https://filebrowser--main--dev-box--alice--suffix.au.example.com",
    );
    expect(urls!.codeServer).toBe(
      "https://code-server--main--dev-box--alice--suffix.au.example.com",
    );
  });

  it("treats an application host without a wildcard as a dot suffix", () => {
    const urls = buildWorkspaceUrls(
      workspace,
      agent,
      "https://coder.example.com",
      "apps.example.com",
    );

    expect(urls!.filebrowser).toBe("https://filebrowser--main--dev-box--alice.apps.example.com");
  });

  it("returns null for empty coderUrl", () => {
    const urls = buildWorkspaceUrls(workspace, agent, "");
    expect(urls).toBeNull();
  });

  it("never includes session tokens in URLs", () => {
    const urls = buildWorkspaceUrls(workspace, agent, "https://coder.example.com");

    expect(urls!.filebrowser).not.toContain("coder_session_token");
    expect(urls!.kasmvnc).not.toContain("coder_session_token");
    expect(urls!.codeServer).not.toContain("coder_session_token");
    expect(urls!.dashboard).not.toContain("coder_session_token");
  });
});

describe("workspace tool folder URLs", () => {
  it("opens VS Code and File Browser at the selected session directory", () => {
    expect(
      buildCodeServerFolderUrl("https://code.example.com", "/home/coder/projects/kethalia/hive"),
    ).toBe("https://code.example.com/?folder=%2Fhome%2Fcoder%2Fprojects%2Fkethalia%2Fhive");
    expect(
      buildFileBrowserFolderUrl("https://files.example.com", "/home/coder/projects/kethalia/hive"),
    ).toBe("https://files.example.com/files/projects/kethalia/hive");
  });

  it("keeps app roots unchanged when no directory is available", () => {
    expect(buildCodeServerFolderUrl("https://code.example.com", null)).toBe(
      "https://code.example.com",
    );
    expect(buildFileBrowserFolderUrl("https://files.example.com", " ")).toBe(
      "https://files.example.com",
    );
  });

  it("preserves app path prefixes and encodes URL delimiters in folders", () => {
    expect(
      buildFileBrowserFolderUrl(
        "/api/workspace-proxy/ws-1/filebrowser",
        "/home/coder/project #1/query?source",
      ),
    ).toBe("/api/workspace-proxy/ws-1/filebrowser/files/project%20%231/query%3Fsource");
    expect(
      buildFileBrowserFolderUrl("https://files.example.com/prefix", "/home/coder/project #1"),
    ).toBe("https://files.example.com/prefix/files/project%20%231");
  });

  it("encodes literal percent signs in File Browser folder segments", () => {
    expect(buildFileBrowserFolderUrl("/api/files", "/home/coder/100%20done")).toBe(
      "/api/files/files/100%2520done",
    );
  });

  it("falls back to the File Browser root for directories outside its configured scope", () => {
    expect(buildFileBrowserFolderUrl("https://files.example.com", "/workspace/repository")).toBe(
      "https://files.example.com/files/",
    );
  });
});
