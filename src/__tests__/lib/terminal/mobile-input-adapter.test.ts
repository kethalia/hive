/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureXtermMobileInput,
  focusTerminalForMobileInput,
  XTERM_HELPER_TEXTAREA_SELECTOR,
} from "@/lib/terminal/mobile-input-adapter";

afterEach(() => {
  document.body.replaceChildren();
});

function renderHelper() {
  const root = document.createElement("div");
  const helper = document.createElement("textarea");
  helper.className = XTERM_HELPER_TEXTAREA_SELECTOR.slice(1);
  root.appendChild(helper);
  document.body.appendChild(root);
  return { helper, root };
}

describe("mobile input adapter", () => {
  it("applies mobile-safe attributes and restores previous helper state", () => {
    const { helper, root } = renderHelper();
    helper.setAttribute("autocapitalize", "sentences");
    helper.setAttribute("autocomplete", "on");
    helper.setAttribute("autocorrect", "on");
    helper.setAttribute("enterkeyhint", "send");
    helper.setAttribute("inputmode", "search");
    helper.setAttribute("spellcheck", "true");
    helper.spellcheck = true;
    helper.style.fontSize = "12px";

    const adapter = configureXtermMobileInput(root);

    expect(adapter.applied).toBe(true);
    expect(adapter.helper).toBe(helper);
    expect(helper).toHaveAttribute("autocapitalize", "off");
    expect(helper).toHaveAttribute("autocomplete", "off");
    expect(helper).toHaveAttribute("autocorrect", "off");
    expect(helper).toHaveAttribute("enterkeyhint", "enter");
    expect(helper).toHaveAttribute("inputmode", "text");
    expect(helper).toHaveAttribute("spellcheck", "false");
    expect(helper).toHaveAttribute("data-terminal-mobile-input", "true");
    expect(helper.spellcheck).toBe(false);
    expect(helper.style.fontSize).toBe("16px");

    adapter.dispose();

    expect(helper).toHaveAttribute("autocapitalize", "sentences");
    expect(helper).toHaveAttribute("autocomplete", "on");
    expect(helper).toHaveAttribute("autocorrect", "on");
    expect(helper).toHaveAttribute("enterkeyhint", "send");
    expect(helper).toHaveAttribute("inputmode", "search");
    expect(helper).toHaveAttribute("spellcheck", "true");
    expect(helper).not.toHaveAttribute("data-terminal-mobile-input");
    expect(helper.spellcheck).toBe(true);
    expect(helper.style.fontSize).toBe("12px");
  });

  it("is a no-op when xterm has not mounted a helper textarea", () => {
    const root = document.createElement("div");

    const adapter = configureXtermMobileInput(root);

    expect(adapter.applied).toBe(false);
    expect(adapter.helper).toBeNull();
    expect(() => adapter.dispose()).not.toThrow();
  });

  it("does not inspect helper textarea values or terminal text", () => {
    const { helper, root } = renderHelper();
    Object.defineProperty(helper, "value", {
      configurable: true,
      get() {
        throw new Error("helper value must not be read");
      },
      set() {
        throw new Error("helper value must not be written");
      },
    });
    helper.textContent = "terminal output must not be read";

    const adapter = configureXtermMobileInput(root);

    expect(adapter.applied).toBe(true);
    expect(helper).toHaveAttribute("data-terminal-mobile-input", "true");
    expect(() => adapter.dispose()).not.toThrow();
  });

  it("focuses only through the existing xterm terminal focus method", () => {
    const focus = vi.fn();

    expect(focusTerminalForMobileInput({ focus })).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focusTerminalForMobileInput(null)).toBe(false);
    expect(focusTerminalForMobileInput({})).toBe(false);
  });
});
