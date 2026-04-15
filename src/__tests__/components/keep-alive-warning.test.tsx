// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const mockStatus = vi.fn();

vi.mock("@/hooks/useKeepAliveStatus", () => ({
  useKeepAliveStatus: (...args: unknown[]) => mockStatus(...args),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children, variant, className }: React.PropsWithChildren<{ variant?: string; className?: string }>) => (
    <div data-testid="alert" data-variant={variant} className={className}>{children}</div>
  ),
  AlertTitle: ({ children }: React.PropsWithChildren) => <div data-testid="alert-title">{children}</div>,
  AlertDescription: ({ children }: React.PropsWithChildren) => <div data-testid="alert-description">{children}</div>,
}));

vi.mock("lucide-react", () => ({
  AlertCircle: () => <span data-testid="alert-icon" />,
}));

import { KeepAliveWarning } from "@/components/workspaces/KeepAliveWarning";

describe("KeepAliveWarning", () => {
  beforeEach(() => {
    mockStatus.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing when consecutiveFailures is 0", () => {
    mockStatus.mockReturnValue({ consecutiveFailures: 0, lastSuccess: null, lastFailure: null, isLoading: false });
    const { container } = render(<KeepAliveWarning workspaceId="ws-1" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when consecutiveFailures is 1", () => {
    mockStatus.mockReturnValue({ consecutiveFailures: 1, lastSuccess: null, lastFailure: null, isLoading: false });
    const { container } = render(<KeepAliveWarning workspaceId="ws-1" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when consecutiveFailures is 2", () => {
    mockStatus.mockReturnValue({ consecutiveFailures: 2, lastSuccess: null, lastFailure: null, isLoading: false });
    const { container } = render(<KeepAliveWarning workspaceId="ws-1" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders destructive Alert when consecutiveFailures reaches 3", () => {
    mockStatus.mockReturnValue({ consecutiveFailures: 3, lastSuccess: null, lastFailure: null, isLoading: false });
    render(<KeepAliveWarning workspaceId="ws-1" />);

    const alert = screen.getByTestId("alert");
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveAttribute("data-variant", "destructive");
    expect(screen.getByTestId("alert-title")).toHaveTextContent("Keep-alive failure");
    expect(screen.getByTestId("alert-description")).toHaveTextContent("3 consecutive failures");
  });

  it("renders with correct failure count above threshold", () => {
    mockStatus.mockReturnValue({ consecutiveFailures: 7, lastSuccess: null, lastFailure: null, isLoading: false });
    render(<KeepAliveWarning workspaceId="ws-1" />);

    expect(screen.getByTestId("alert-description")).toHaveTextContent("7 consecutive failures");
  });

  it("passes workspaceId to useKeepAliveStatus", () => {
    mockStatus.mockReturnValue({ consecutiveFailures: 0, lastSuccess: null, lastFailure: null, isLoading: false });
    render(<KeepAliveWarning workspaceId="my-workspace-42" />);

    expect(mockStatus).toHaveBeenCalledWith("my-workspace-42");
  });

  it("mentions workspace may auto-stop in description", () => {
    mockStatus.mockReturnValue({ consecutiveFailures: 5, lastSuccess: null, lastFailure: null, isLoading: false });
    render(<KeepAliveWarning workspaceId="ws-1" />);

    expect(screen.getByTestId("alert-description")).toHaveTextContent("auto-stop");
  });
});
