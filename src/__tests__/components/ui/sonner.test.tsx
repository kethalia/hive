// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const mockSonner = vi.hoisted(() =>
  vi.fn(({ theme }: { theme?: string }) => <div data-testid="sonner" data-theme={theme} />),
);

vi.mock("sonner", () => ({
  Toaster: mockSonner,
}));

import { Toaster } from "@/components/ui/sonner";

describe("Toaster", () => {
  afterEach(() => {
    cleanup();
    document.documentElement.className = "";
    mockSonner.mockClear();
  });

  it("renders without a ThemeProvider and derives theme from the document class", async () => {
    const { getByTestId } = render(<Toaster />);

    await waitFor(() => {
      expect(getByTestId("sonner")).toHaveAttribute("data-theme", "light");
    });

    document.documentElement.classList.add("dark");

    await waitFor(() => {
      expect(getByTestId("sonner")).toHaveAttribute("data-theme", "dark");
    });
  });
});
