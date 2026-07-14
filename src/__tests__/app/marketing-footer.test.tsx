// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import MarketingPage from "@/app/(marketing)/page";

describe("marketing footer", () => {
  afterEach(cleanup);

  it("keeps the public header clear of asymmetric iPhone safe areas", () => {
    render(<MarketingPage />);

    const header = screen.getByRole("banner");
    expect(header).toHaveClass("pt-safe");
    expect(header.firstElementChild).toHaveClass(
      "pl-[max(1rem,var(--safe-area-inset-left))]",
      "pr-[max(1rem,var(--safe-area-inset-right))]",
    );
  });

  it("credits Kethalia with a direct external link", () => {
    render(<MarketingPage />);

    expect(screen.getByText(/UI \/ UX by/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Kethalia" })).toHaveAttribute(
      "href",
      "https://kethalia.com",
    );
  });
});
