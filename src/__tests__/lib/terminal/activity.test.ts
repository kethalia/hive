// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { observeTerminalActivity } from "@/lib/terminal/activity";

afterEach(() => document.body.replaceChildren());

function setup() {
  const board = document.createElement("section");
  const terminal = document.createElement("div");
  board.append(terminal);
  document.body.append(board);
  const cancel = vi.fn();
  const observer = observeTerminalActivity(terminal, cancel);
  return { board, terminal, cancel, observer };
}

it.each([
  false,
  true,
])("revokes a grant even when inert is removed before delivery (synchronous=%s)", async (synchronous) => {
  const { board, cancel, observer } = setup();
  board.setAttribute("inert", "");
  board.removeAttribute("inert");
  if (synchronous) observer.flush();
  else await Promise.resolve();
  expect(cancel).toHaveBeenCalledOnce();
  observer.dispose();
});

it("revokes a grant after parking and immediately restoring the same DOM", () => {
  const { board, terminal, cancel, observer } = setup();
  const parking = document.createElement("div");
  parking.setAttribute("inert", "");
  document.body.append(parking);
  parking.append(terminal);
  board.append(terminal);
  observer.flush();
  expect(cancel).toHaveBeenCalledOnce();
  observer.dispose();
});

it("tracks new ancestors after reparenting", () => {
  const { terminal, cancel, observer } = setup();
  const board = document.createElement("section");
  document.body.append(board);
  board.append(terminal);
  observer.flush();
  cancel.mockClear();
  board.setAttribute("inert", "");
  observer.flush();
  expect(cancel).toHaveBeenCalledOnce();
  observer.dispose();
});

it("tracks ancestors after a detached surface is mounted again", () => {
  const { terminal, cancel, observer } = setup();
  terminal.remove();
  observer.flush();
  const board = document.createElement("section");
  document.body.append(board);
  board.append(terminal);
  observer.flush();
  cancel.mockClear();
  board.setAttribute("inert", "");
  observer.flush();
  expect(cancel).toHaveBeenCalledOnce();
  observer.dispose();
});

it("ignores output redraws and unrelated inactive panes", () => {
  const { terminal, cancel, observer } = setup();
  const screen = document.createElement("div");
  terminal.append(screen);
  screen.replaceChildren(document.createElement("span"));
  const sibling = document.createElement("section");
  document.body.append(sibling);
  sibling.setAttribute("inert", "");
  observer.flush();
  expect(cancel).not.toHaveBeenCalled();
  observer.dispose();
});

it("stops observing on disposal", async () => {
  const { board, cancel, observer } = setup();
  observer.dispose();
  board.setAttribute("inert", "");
  await Promise.resolve();
  observer.flush();
  expect(cancel).not.toHaveBeenCalled();
});
