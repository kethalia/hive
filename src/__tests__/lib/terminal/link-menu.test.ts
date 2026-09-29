// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createTerminalLinkMenu } from "@/lib/terminal/link-menu";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers();
  const action = vi.fn();
  const menu = createTerminalLinkMenu(action);
  cleanups.push(menu.dispose);
  return { menu, action };
}

it("keeps an opened menu reachable during a slow pointer crossing and late xterm leave", () => {
  const { menu, action } = setup();
  menu.hover("docs/image.png", 80, 100);
  vi.advanceTimersByTime(400);
  const popup = document.querySelector<HTMLElement>("[role=menu]")!;
  menu.leave();
  vi.advanceTimersByTime(2000);
  expect(popup.isConnected).toBe(true);
  popup.dispatchEvent(new Event("pointerenter"));
  menu.leave(); // xterm's leave may follow the portal's pointerenter.
  vi.advanceTimersByTime(2000);
  popup.querySelectorAll<HTMLButtonElement>("button")[2].click();
  expect(action).toHaveBeenCalledWith("docs/image.png", "open");
  expect(popup.isConnected).toBe(false);
});

it("does not move or recreate the menu when terminal redraws repeat a hover", () => {
  const { menu } = setup();
  menu.show("docs/image.png", 80, 100);
  const popup = document.querySelector<HTMLElement>("[role=menu]")!;
  const position = [popup.style.left, popup.style.top];
  menu.hover("docs/image.png", 100, 120);
  vi.advanceTimersByTime(1000);
  expect(document.querySelector("[role=menu]")).toBe(popup);
  expect([popup.style.left, popup.style.top]).toEqual(position);
});

it("cancels an unopened hover and keeps only one terminal menu visible", () => {
  const first = setup().menu;
  first.hover("docs/first.png", 10, 10);
  first.leave();
  vi.advanceTimersByTime(1000);
  expect(document.querySelector("[role=menu]")).toBeNull();
  first.show("docs/first.png", 10, 10);
  const second = setup().menu;
  second.show("docs/second.png", 20, 20);
  expect(document.querySelectorAll("[role=menu]")).toHaveLength(1);
  expect(document.querySelector("[role=menu]")?.textContent).toContain("docs/second.png");
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(document.querySelector("[role=menu]")).toBeNull();
});

it("repositions the same destination for another link instance but preserves repeated hovers", () => {
  const { menu } = setup();
  menu.show("docs/image.png", 80, 100, false, "1:1:14:1");
  const first = document.querySelector<HTMLElement>("[role=menu]")!;
  menu.hover("docs/image.png", 100, 105, "1:1:14:1");
  vi.advanceTimersByTime(400);
  expect(document.querySelector("[role=menu]")).toBe(first);
  menu.hover("docs/image.png", 200, 200, "1:3:14:3");
  vi.advanceTimersByTime(400);
  const second = document.querySelector<HTMLElement>("[role=menu]")!;
  expect(second).not.toBe(first);
  expect(second.style.left).toBe("200px");
  expect(second.style.top).toBe("210px");
});
