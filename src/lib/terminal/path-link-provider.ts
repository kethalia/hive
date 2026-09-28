import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { terminalPathMatches } from "./link-target";

export function terminalPathLinkProvider(
  term: Terminal,
  handlers: Pick<ILink, "activate" | "hover" | "leave">,
): ILinkProvider {
  return {
    provideLinks(lineNumber, callback) {
      const buffer = term.buffer.active;
      let start = lineNumber - 1;
      let end = start;
      while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
      while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) end++;
      let text = "";
      const cells: { x: number; y: number }[] = [];
      for (let row = start; row <= end; row++) {
        const line = buffer.getLine(row);
        if (!line) continue;
        for (let col = 0; col < term.cols; col++) {
          const cell = line.getCell(col);
          if (!cell || cell.getWidth() === 0) continue;
          const chars = cell.getChars() || " ";
          for (let i = 0; i < chars.length; i++) cells.push({ x: col + 1, y: row + 1 });
          text += chars;
        }
      }
      callback(
        terminalPathMatches(text).flatMap((match) => {
          const first = cells[match.index];
          const last = cells[match.index + match.text.length - 1];
          if (!first || !last || first.y > lineNumber || last.y < lineNumber) return [];
          return [{ text: match.text, range: { start: first, end: last }, ...handlers }];
        }),
      );
    },
  };
}
