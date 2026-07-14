// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import MarketingPage from "@/app/(marketing)/page";

describe("marketing footer", () => {
  it("credits Kethalia with a direct external link", () => {
    render(<MarketingPage />);

    expect(screen.getByText(/UI \/ UX by/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Kethalia" })).toHaveAttribute(
      "href",
      "https://kethalia.com",
    );
  });
});
