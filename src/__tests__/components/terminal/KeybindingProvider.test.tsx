// @vitest-environment jsdom
import { render, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeybindingContextValue } from "@/hooks/useKeybindings";
import { useKeybindings } from "@/hooks/useKeybindings";
import { KeybindingProvider } from "@/components/terminal/KeybindingProvider";

vi.mock("@/lib/terminal/actions", () => ({
  copyTerminalSelection: vi.fn(() => false),
}));

function makeKeyEvent(opts: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", opts);
}

describe("KeybindingProvider", () => {
  afterEach(() => {
    cleanup();
  });

  function renderWithProbe() {
    let context: KeybindingContextValue | null = null;

    function Probe() {
      context = useKeybindings();
      return null;
    }

    render(
      <KeybindingProvider>
        <Probe />
      </KeybindingProvider>,
    );

    return {
      get context() {
        return context;
      },
    };
  }

  it("registers copy but leaves keyboard paste to native terminal handling", async () => {
    const probe = renderWithProbe();

    await waitFor(() => {
      expect(probe.context?.getAll().some((entry) => entry.id === "copy")).toBe(true);
    });

    const entries = probe.context?.getAll() ?? [];
    expect(entries.map((entry) => entry.id)).toContain("copy");
    expect(entries.map((entry) => entry.id)).not.toContain("paste");
    expect(entries.flatMap((entry) => entry.keys)).not.toContain("ctrl+v");
    expect(entries.flatMap((entry) => entry.keys)).not.toContain("cmd+v");
    expect(probe.context?.handleKeyEvent(makeKeyEvent({ key: "v", ctrlKey: true }))).toBe(true);
    expect(probe.context?.handleKeyEvent(makeKeyEvent({ key: "v", metaKey: true }))).toBe(true);
  });
});
