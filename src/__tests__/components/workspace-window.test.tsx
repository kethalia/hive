// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { WorkspaceWindowDropPlaceholder } from "@/components/workspaces/WorkspaceWindow";

describe("WorkspaceWindowDropPlaceholder", () => {
  afterEach(cleanup);

  it("renders a standalone empty destination slot with the predicted geometry", () => {
    render(
      <WorkspaceWindowDropPlaceholder
        style={{ left: "50%", top: "50%", width: "25%", height: "50%" }}
      />,
    );

    const placeholder = screen.getByTestId("workspace-window-drop-placeholder");
    expect(placeholder).toHaveClass("absolute", "p-0.5", "pointer-events-none");
    expect(placeholder).toHaveStyle({ left: "50%", top: "50%", width: "25%", height: "50%" });
    expect(placeholder).not.toHaveAttribute("data-workspace-window-id");
    expect(placeholder.firstElementChild).toHaveClass(
      "h-full",
      "w-full",
      "rounded-md",
      "border-primary/80",
    );
    expect(placeholder.firstElementChild).toBeEmptyDOMElement();
  });
});
