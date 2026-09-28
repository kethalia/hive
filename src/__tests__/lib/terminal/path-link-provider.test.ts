import type { ILink, Terminal } from "@xterm/xterm";
import { expect, it, vi } from "vitest";
import { terminalPathLinkProvider } from "@/lib/terminal/path-link-provider";

it("links complete paths across wrapped terminal rows", () => {
  const rows = ["See docs/des", "ign/file.png", "plain text  "];
  const terminal = {
    cols: 12,
    buffer: {
      active: {
        length: rows.length,
        getLine: (row: number) => ({
          isWrapped: row === 1,
          getCell: (column: number) => ({ getWidth: () => 1, getChars: () => rows[row][column] }),
        }),
      },
    },
  } as unknown as Terminal;
  const provider = terminalPathLinkProvider(terminal, { activate: vi.fn() });
  for (const row of [1, 2]) {
    let links: ILink[] | undefined;
    provider.provideLinks(row, (result) => {
      links = result;
    });
    expect(links).toHaveLength(1);
    expect(links?.[0]).toMatchObject({
      text: "docs/design/file.png",
      range: { start: { x: 5, y: 1 }, end: { x: 12, y: 2 } },
    });
  }
  const callback = vi.fn();
  provider.provideLinks(3, callback);
  expect(callback).toHaveBeenCalledWith([]);
});
