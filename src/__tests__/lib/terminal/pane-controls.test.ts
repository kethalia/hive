// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activatePaneControl } from "@/lib/terminal/pane-controls";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  document.body.innerHTML = `
    <div data-terminal-audio-frame="true" data-active="false" id="terminal">
      <textarea></textarea><button data-terminal-control="close">Close terminal</button>
    </div>
    <div data-terminal-audio-frame="true" data-active="true" id="settings" tabindex="0">
      <button data-terminal-control="close">Close Settings</button>
    </div>`;
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("pane control focus", () => {
  it("closes the selected tool even if DOM and terminal-context focus still point at the inactive terminal", () => {
    const terminal = document.querySelector<HTMLTextAreaElement>("textarea")!;
    const closeTerminal = vi.fn();
    const closeSettings = vi.fn();
    document.querySelector("#terminal button")!.addEventListener("click", closeTerminal);
    document.querySelector("#settings button")!.addEventListener("click", closeSettings);
    terminal.focus();
    expect(activatePaneControl("close", terminal)).toBe(false);
    expect(closeSettings).toHaveBeenCalledOnce();
    expect(closeTerminal).not.toHaveBeenCalled();
  });
  it("leaves panes alone when a dialog is open", () => {
    const close = vi.fn();
    document.querySelector("#settings button")!.addEventListener("click", close);
    document.body.insertAdjacentHTML("beforeend", '<div role="dialog"></div>');
    expect(activatePaneControl("close")).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });
});
