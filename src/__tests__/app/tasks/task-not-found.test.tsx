// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import TaskNotFound from "@/app/(dashboard)/tasks/[id]/not-found";

describe("TaskNotFound", () => {
  afterEach(cleanup);

  it("renders recovery destinations as links", () => {
    render(<TaskNotFound />);

    expect(
      screen.getByRole("heading", { name: "This task is no longer available." }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/tasks");
    expect(screen.getByRole("link", { name: "New task" })).toHaveAttribute("href", "/tasks/new");
  });
});
