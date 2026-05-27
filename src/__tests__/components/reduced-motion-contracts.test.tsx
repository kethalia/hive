// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => true,
}));

import { Sidebar, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
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

  it("carries the Sheet reduced-motion contract through the mobile sidebar drawer", async () => {
    render(
      <SidebarProvider>
        <SidebarTrigger />
        <Sidebar>
          <nav aria-label="Mobile workspace navigation">Navigation</nav>
        </Sidebar>
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));

    await waitFor(() => {
      const drawer = document.querySelector<HTMLElement>('[data-mobile="true"]');
      expect(drawer).not.toBeNull();
      expect(drawer?.className).toContain("motion-reduce:transition-none");
      expect(drawer?.className).toContain("motion-reduce:duration-0");
      expect(drawer?.className).toContain(
        "data-[side=left]:!top-[calc(var(--safe-area-inset-top)+3.5rem)]",
      );
      expect(drawer?.className).toContain(
        "data-[side=left]:!h-[calc(100dvh-var(--safe-area-inset-top)-3.5rem)]",
      );
    });
  });
});
