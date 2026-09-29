import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { type TerminalPathValidator, terminalLinkTarget, terminalPathMatches } from "./link-target";

export function terminalPathLinkProvider(
  term: Terminal,
  handlers: Pick<ILink, "activate" | "hover" | "leave">,
  validatePaths: TerminalPathValidator = () => [],
): ILinkProvider {
  let requestGeneration = 0;
  return {
    provideLinks(lineNumber, callback) {
      const generation = ++requestGeneration;
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
      const links = terminalPathMatches(text).flatMap((match) => {
        const first = cells[match.index];
        const last = cells[match.index + match.text.length - 1];
        if (!first || !last || first.y > lineNumber || last.y < lineNumber) return [];
        return [{ text: match.text, range: { start: first, end: last }, ...handlers }];
      });
      if (!links.length) {
        callback([]);
        return;
      }
      const viewportY = buffer.viewportY;
      const cols = term.cols;
      const rows = term.rows;
      const snapshot = Array.from({ length: end - start + 1 }, (_, i) =>
        buffer.getLine(start + i)?.translateToString(),
      );
      const deliver = (existing: string[]) => {
        // xterm associates replies with its current line, including empty replies.
        if (generation !== requestGeneration) return;
        if (
          term.buffer.active !== buffer ||
          buffer.viewportY !== viewportY ||
          term.cols !== cols ||
          term.rows !== rows ||
          snapshot.some((line, i) => buffer.getLine(start + i)?.translateToString() !== line)
        ) {
          callback([]);
          return;
        }
        const valid = new Set(existing);
        callback(links.filter((link) => valid.has(terminalLinkTarget(link.text)?.value ?? "")));
      };
      try {
        const result = validatePaths([
          ...new Set(links.map((link) => terminalLinkTarget(link.text)?.value ?? "")),
        ]);
        if (Array.isArray(result)) deliver(result);
        else void result.then(deliver, () => deliver([]));
      } catch {
        deliver([]);
      }
    },
  };
}
