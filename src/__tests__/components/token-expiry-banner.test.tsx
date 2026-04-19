// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/components/ui/alert", () => ({
  Alert: ({
    children,
    variant,
  }: React.PropsWithChildren<{ variant?: string }>) => (
    <div data-testid="alert" data-variant={variant}>
      {children}
    </div>
  ),
  AlertTitle: ({ children }: React.PropsWithChildren) => (
    <div data-testid="alert-title">{children}</div>
  ),
  AlertDescription: ({ children }: React.PropsWithChildren) => (
    <div data-testid="alert-description">{children}</div>
  ),
}));

vi.mock("lucide-react", () => ({
  AlertCircle: () => <span data-testid="icon-alert-circle" />,
  Clock: () => <span data-testid="icon-clock" />,
}));

import { TokenExpiryBanner } from "@/components/token-expiry-banner";

describe("TokenExpiryBanner", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing for valid status", () => {
    const { container } = render(
      <TokenExpiryBanner
        status={{ status: "valid", expiresAt: new Date("2026-05-01") }}
      />
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders destructive alert for expired status", () => {
    render(
      <TokenExpiryBanner
        status={{ status: "expired", expiresAt: new Date("2026-04-01") }}
      />
    );
    const alert = screen.getByTestId("alert");
    expect(alert).toHaveAttribute("data-variant", "destructive");
    expect(screen.getByTestId("alert-title")).toHaveTextContent(
      "Token Expired"
    );
    expect(screen.getByTestId("alert-description")).toHaveTextContent(
      "Your Coder API token has expired"
    );
    expect(screen.getByTestId("icon-alert-circle")).toBeInTheDocument();
  });

  it("renders destructive alert for key_mismatch status", () => {
    render(
      <TokenExpiryBanner
        status={{ status: "key_mismatch", expiresAt: new Date("2026-05-01") }}
      />
    );
    const alert = screen.getByTestId("alert");
    expect(alert).toHaveAttribute("data-variant", "destructive");
    expect(screen.getByTestId("alert-title")).toHaveTextContent(
      "Re-authentication Required"
    );
    expect(screen.getByTestId("alert-description")).toHaveTextContent(
      "encryption key has changed"
    );
    expect(screen.getByTestId("icon-alert-circle")).toBeInTheDocument();
  });

  it("renders default alert for expiring status with hours remaining", () => {
    const threeHoursFromNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
    render(
      <TokenExpiryBanner
        status={{ status: "expiring", expiresAt: threeHoursFromNow }}
      />
    );
    const alert = screen.getByTestId("alert");
    expect(alert).toHaveAttribute("data-variant", "default");
    expect(screen.getByTestId("alert-title")).toHaveTextContent(
      "Token Expiring Soon"
    );
    expect(screen.getByTestId("alert-description")).toHaveTextContent(
      "3 hours"
    );
    expect(screen.getByTestId("icon-clock")).toBeInTheDocument();
  });

  it("renders singular 'hour' when 1 hour remaining", () => {
    const oneHourFromNow = new Date(Date.now() + 1 * 60 * 60 * 1000);
    render(
      <TokenExpiryBanner
        status={{ status: "expiring", expiresAt: oneHourFromNow }}
      />
    );
    expect(screen.getByTestId("alert-description")).toHaveTextContent(
      "1 hour"
    );
    expect(screen.getByTestId("alert-description")).not.toHaveTextContent(
      "hours"
    );
  });
});
