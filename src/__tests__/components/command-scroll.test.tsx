// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.unstubAllGlobals();
});

describe("command list touch ownership", () => {
  it("keeps native scrolling available without leaking touch gestures to the document", () => {
    render(
      <Command>
        <CommandList>
          <CommandItem>Settings</CommandItem>
        </CommandList>
      </Command>,
    );
    const target = screen.getByRole("option");
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      const listener = vi.fn();
      document.addEventListener(type, listener);
      try {
        const event = new Event(type, { bubbles: true, cancelable: true });
        fireEvent(target, event);
        expect(event.defaultPrevented).toBe(false);
        expect(listener).not.toHaveBeenCalled();
      } finally {
        document.removeEventListener(type, listener);
      }
    }
  });

  it("retains tap selection and keyboard navigation when pointer hover selection is disabled", () => {
    const first = vi.fn(),
      second = vi.fn();
    render(
      <Command disablePointerSelection>
        <CommandInput />
        <CommandList>
          <CommandItem onSelect={first}>First</CommandItem>
          <CommandItem onSelect={second}>Second</CommandItem>
        </CommandList>
      </Command>,
    );
    fireEvent.pointerMove(screen.getByText("Second"), { pointerType: "touch" });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(first).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Second"));
    expect(second).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(first).toHaveBeenCalledTimes(2);
  });
});
