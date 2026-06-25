// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODE_SERVER_POPUP_FEATURES,
  CODE_SERVER_POPUP_TARGET,
  openCodeServerPopupUrl,
  shouldEmbedCodeServerInCurrentBrowser,
} from "@/lib/workspaces/code-server-embed";

describe("code-server embed browser support", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("embeds in Chromium browsers", () => {
    expect(
      shouldEmbedCodeServerInCurrentBrowser({
        vendor: "Google Inc.",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      }),
    ).toBe(true);
  });

  it("falls back to a popup for Safari", () => {
    expect(
      shouldEmbedCodeServerInCurrentBrowser({
        vendor: "Apple Computer, Inc.",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      }),
    ).toBe(false);
  });

  it("opens code-server in a constrained named popup", () => {
    const open = vi.fn(() => ({ opener: {} }));
    vi.stubGlobal("open", open);

    openCodeServerPopupUrl("https://code.example.test");

    expect(open).toHaveBeenCalledWith(
      "https://code.example.test",
      CODE_SERVER_POPUP_TARGET,
      CODE_SERVER_POPUP_FEATURES,
    );
    expect(CODE_SERVER_POPUP_FEATURES).toContain("popup=yes");
    expect(CODE_SERVER_POPUP_FEATURES).toContain("location=no");
    expect(CODE_SERVER_POPUP_FEATURES).toContain("toolbar=no");
    expect(CODE_SERVER_POPUP_FEATURES).toContain("menubar=no");
  });
});
