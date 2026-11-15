// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
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
  it("keeps keyboard selection through scroll-generated hover and resumes hover when the mouse moves", () => {
    const first = vi.fn();
    render(
      <Command>
        <CommandInput />
        <CommandList>
          <CommandItem onSelect={first}>First</CommandItem>
          <CommandItem>Second</CommandItem>
          <CommandItem>Third</CommandItem>
          <CommandItem>Fourth</CommandItem>
        </CommandList>
      </Command>,
    );
    const input = screen.getByRole("combobox");
    fireEvent.pointerMove(screen.getByText("First"), { clientX: 100, clientY: 100 });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByText("Second").getAttribute("aria-selected")).toBe("true");
    fireEvent.scroll(screen.getByRole("listbox"));
    fireEvent.pointerMove(screen.getByText("First"), { clientX: 100, clientY: 100 });
    expect(screen.getByText("Second").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByText("Third").getAttribute("aria-selected")).toBe("true");

    fireEvent.pointerMove(screen.getByText("Fourth"), { clientX: 100, clientY: 101 });
    expect(screen.getByText("Fourth").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.pointerMove(screen.getByText("Second"), { clientX: 100, clientY: 101 });
    expect(screen.getByText("Third").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByText("First"));
    expect(first).toHaveBeenCalledOnce();
  });

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
