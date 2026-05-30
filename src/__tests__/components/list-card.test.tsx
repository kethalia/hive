// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";

import {
  CardStack,
  ListCard,
  ListCardAction,
  ListCardActions,
  ListCardHeader,
  ListCardMeta,
  ListCardMetaBadge,
  ListCardRow,
  ListCardRows,
  ListCardTitle,
} from "@/components/ui/list-card";

function renderExampleCard() {
  return render(
    <CardStack data-testid="stack">
      <ListCard data-testid="card">
        <ListCardHeader>
          <ListCardTitle>Deploy API</ListCardTitle>
          <ListCardMeta data-testid="meta">
            <span>Updated 2m ago</span>
            <ListCardMetaBadge>Running</ListCardMetaBadge>
          </ListCardMeta>
        </ListCardHeader>
        <ListCardRows data-testid="rows">
          <ListCardRow label="Owner">Ada</ListCardRow>
          <ListCardRow label="Status">Healthy</ListCardRow>
        </ListCardRows>
        <ListCardActions data-testid="actions">
          <ListCardAction>Open</ListCardAction>
          <ListCardAction as="a" href="/tasks/1">
            Details
          </ListCardAction>
        </ListCardActions>
      </ListCard>
    </CardStack>,
  );
}

afterEach(() => {
  cleanup();
});

describe("list-card primitives", () => {
  it("renders the shared card stack slots with stable roles and data attributes", () => {
    renderExampleCard();

    const stack = screen.getByRole("list");
    expect(stack).toHaveAttribute("data-list-card-slot", "stack");
    expect(stack).toHaveClass("grid", "gap-3", "pb-safe", "text-sm", "md:hidden");

    const card = screen.getByRole("listitem");
    expect(card).toHaveAttribute("data-list-card-slot", "card");
    expect(card).toHaveClass("text-sm", "leading-6");

    expect(screen.getByText("Deploy API")).toHaveAttribute("data-list-card-slot", "title");
    expect(screen.getByTestId("meta")).toHaveAttribute("data-list-card-slot", "meta");
    expect(screen.getByText("Running")).toHaveAttribute("data-list-card-slot", "meta-badge");
    expect(screen.getByTestId("rows")).toHaveAttribute("data-list-card-slot", "rows");
    expect(screen.getByText("Owner")).toHaveAttribute("data-list-card-slot", "row-label");
    expect(screen.getByText("Ada")).toHaveAttribute("data-list-card-slot", "row-value");
    expect(screen.getByTestId("actions")).toHaveAttribute("data-list-card-slot", "actions");
  });

  it("keeps action helpers at the 44px touch contract with visible focus styles", () => {
    const { container } = renderExampleCard();

    const actions = container.querySelectorAll<HTMLElement>('[data-list-card-slot="action"]');
    expect(actions).toHaveLength(2);

    for (const action of actions) {
      expect(action).toHaveClass("min-h-11", "touch-manipulation", "text-sm");
      expect(action.className).toContain("focus-visible:ring-3");
      expect(action.className).toContain("focus-visible:border-ring");
    }

    expect(screen.getByTestId("actions")).toHaveClass("gap-2", "flex-wrap");
    expect(screen.getByRole("button", { name: "Open" })).toHaveClass("min-h-11");
    expect(screen.getByRole("link", { name: "Details" })).toHaveClass("min-h-11");
  });

  it("keeps metadata and body text readable even when className extends the component", () => {
    render(
      <CardStack className="custom-stack pb-0" data-testid="stack">
        <ListCard className="custom-card text-[10px]" data-testid="card">
          <ListCardHeader>
            <ListCardTitle className="custom-title text-[10px]">Readable title</ListCardTitle>
            <ListCardMeta className="custom-meta text-[10px]" data-testid="meta">
              Readable meta
            </ListCardMeta>
          </ListCardHeader>
          <ListCardRows className="custom-rows text-[10px]" data-testid="rows">
            <ListCardRow className="custom-row text-[10px]" label="Readable label">
              Readable body
            </ListCardRow>
          </ListCardRows>
          <ListCardActions>
            <ListCardAction className="custom-action min-h-4">Safe action</ListCardAction>
          </ListCardActions>
        </ListCard>
      </CardStack>,
    );

    expect(screen.getByTestId("stack")).toHaveClass("custom-stack", "pb-safe", "pb-4");
    expect(screen.getByTestId("card")).toHaveClass("custom-card", "text-sm", "leading-6");
    expect(screen.getByText("Readable title")).toHaveClass("custom-title", "text-base");
    expect(screen.getByTestId("meta")).toHaveClass("custom-meta", "text-xs", "leading-5");
    expect(screen.getByTestId("rows")).toHaveClass("custom-rows", "text-sm", "leading-6");
    expect(screen.getByText("Readable body")).toHaveClass("text-sm", "leading-6");
    expect(screen.getByRole("button", { name: "Safe action" })).toHaveClass(
      "custom-action",
      "min-h-11",
    );

    expect(screen.getByTestId("meta").className).not.toContain("text-[10px]");
    expect(screen.getByRole("button", { name: "Safe action" }).className).not.toContain("min-h-4");
  });

  it("does not throw for empty metadata, body, and action slots", () => {
    expect(() =>
      render(
        <CardStack>
          <ListCard>
            <ListCardHeader>
              <ListCardTitle />
              <ListCardMeta />
            </ListCardHeader>
            <ListCardRows>
              <ListCardRow />
            </ListCardRows>
            <ListCardActions />
          </ListCard>
        </CardStack>,
      ),
    ).not.toThrow();
  });

  it("renders on the server without client-only browser APIs", () => {
    const html = renderToString(
      <CardStack>
        <ListCard>
          <ListCardHeader>
            <ListCardTitle>Server rendered</ListCardTitle>
            <ListCardMeta>Static metadata</ListCardMeta>
          </ListCardHeader>
          <ListCardRows>
            <ListCardRow label="Mode">SSR</ListCardRow>
          </ListCardRows>
          <ListCardActions>
            <ListCardAction as="a" href="/server">
              View
            </ListCardAction>
          </ListCardActions>
        </ListCard>
      </CardStack>,
    );

    expect(html).toContain('data-list-card-slot="stack"');
    expect(html).toContain('data-list-card-slot="action"');
    expect(html).toContain("Server rendered");
  });
});
