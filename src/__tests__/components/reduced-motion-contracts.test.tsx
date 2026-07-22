// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => true,
}));

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Sidebar, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";

function MobileSidebarSwitcher() {
  const { setOpenMobile, setOpenMobileRight } = useSidebar();
  return (
    <>
      <button type="button" onClick={() => setOpenMobile(true)}>
        Open left
      </button>
      <button type="button" onClick={() => setOpenMobileRight(true)}>
        Open right
      </button>
      <Sidebar>
        <nav aria-label="Left navigation">Left navigation</nav>
      </Sidebar>
      <Sidebar side="right" mobileOnly>
        <nav aria-label="Right navigation">Right navigation</nav>
      </Sidebar>
    </>
  );
}

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
      const wrapper = document.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]');
      const drawer = document.querySelector<HTMLElement>('[data-mobile="true"]');
      const inner = document.querySelector<HTMLElement>('[data-slot="sidebar-mobile-inner"]');
      expect(wrapper).not.toBeNull();
      expect(drawer).not.toBeNull();
      expect(inner).not.toBeNull();
      expect(wrapper?.className).toContain("min-h-[var(--app-viewport-height)]");
      expect(drawer?.className).toContain("motion-reduce:transition-none");
      expect(drawer?.className).toContain("motion-reduce:duration-0");
      expect(drawer?.className).toContain("data-[side=left]:!top-0");
      expect(drawer?.className).toContain("data-[side=left]:!bottom-auto");
      expect(drawer?.className).toContain("data-[side=left]:!h-[var(--app-viewport-height)]");
      expect(drawer?.className).toContain("data-[side=left]:!min-h-0");
      expect(drawer?.className).toContain("data-[side=left]:!max-h-none");
      expect(drawer?.className).toContain("!gap-0");
      expect(drawer?.className).toContain("overflow-hidden");
      expect(drawer?.className).not.toContain("pt-[calc(var(--safe-area-inset-top)+0.5rem)]");
      expect(inner?.className).toContain("h-full");
      expect(inner?.className).toContain("min-h-0");
      expect(inner?.className).toContain("pt-[calc(var(--safe-area-inset-top)+0.5rem)]");
      expect(inner?.className).not.toContain("pb-[var(--safe-area-inset-bottom)]");
    });
  });

  it("keeps the left and right mobile sidebars mutually exclusive at the same dimensions", async () => {
    render(
      <SidebarProvider>
        <MobileSidebarSwitcher />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open right" }));
    await waitFor(() =>
      expect(screen.getByRole("navigation", { name: "Right navigation" })).toBeVisible(),
    );
    const rightDrawer = document.querySelector<HTMLElement>(
      '[data-mobile="true"][data-side="right"]',
    );
    expect(rightDrawer).not.toBeNull();
    expect(rightDrawer?.className).toContain("data-[side=right]:!h-[var(--app-viewport-height)]");
    expect(rightDrawer).toHaveStyle({ "--sidebar-width": "18rem" });
    expect(screen.queryByRole("navigation", { name: "Left navigation" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Open left"));
    await waitFor(() =>
      expect(screen.getByRole("navigation", { name: "Left navigation" })).toBeVisible(),
    );
    expect(screen.queryByRole("navigation", { name: "Right navigation" })).not.toBeInTheDocument();
  });
});
