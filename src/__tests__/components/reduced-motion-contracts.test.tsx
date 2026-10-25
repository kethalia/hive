// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => true,
}));

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

afterEach(() => {
  cleanup();
});

describe("reduced-motion class contracts", () => {
  it("exposes motion-reduce contracts on shared Sheet overlay and content", async () => {
    render(
      <Sheet open={true} onOpenChange={() => {}}>
        <SheetContent side="bottom" showCloseButton={false}>
          <SheetTitle>Reduced motion sheet</SheetTitle>
          <p>Sheet body</p>
        </SheetContent>
      </Sheet>,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-slot="sheet-overlay"]')).not.toBeNull();
      expect(document.querySelector('[data-slot="sheet-content"]')).not.toBeNull();
    });

    const overlay = document.querySelector<HTMLElement>('[data-slot="sheet-overlay"]');
    const content = document.querySelector<HTMLElement>('[data-slot="sheet-content"]');

    expect(overlay).not.toBeNull();
    expect(content).not.toBeNull();
    expect(overlay?.className).toContain("motion-reduce:transition-none");
    expect(overlay?.className).toContain("motion-reduce:duration-0");
    expect(content?.className).toContain("motion-reduce:transition-none");
    expect(content?.className).toContain("motion-reduce:duration-0");
  });
});
