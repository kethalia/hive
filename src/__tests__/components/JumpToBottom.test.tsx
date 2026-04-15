// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { JumpToBottom } from "@/components/workspaces/JumpToBottom";

vi.mock("lucide-react", () => ({
  ArrowDown: () => <span data-testid="arrow-down-icon" />,
}));

afterEach(cleanup);

describe("JumpToBottom", () => {
  it("renders visibly when visible is true", () => {
    render(<JumpToBottom visible={true} onClick={vi.fn()} />);
    const button = screen.getByRole("button", { name: /jump to bottom/i });
    expect(button).toBeDefined();
    expect(button.className).toContain("opacity-100");
    expect(button.className).not.toMatch(/(?<!\S)pointer-events-none(?!\S)/);
  });

  it("is hidden when visible is false", () => {
    render(<JumpToBottom visible={false} onClick={vi.fn()} />);
    const button = screen.getByRole("button", { name: /jump to bottom/i });
    expect(button.className).toContain("opacity-0");
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<JumpToBottom visible={true} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: /jump to bottom/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
