import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import {
  TERMINAL_PATH_BATCH_SIZE,
  type TerminalPathValidator,
  terminalLinkTarget,
  terminalPathMatches,
} from "./link-target";

export function terminalPathLinkProvider(
  term: Terminal,
  handlers: Pick<ILink, "activate" | "hover" | "leave">,
  validatePaths: TerminalPathValidator = () => [],
): ILinkProvider & { isValidationPending(event: MouseEvent): boolean } {
  let requestGeneration = 0;
  let pendingLinks: ILink[] = [];

  return {
    isValidationPending(event) {
      const rect = term.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
      if (!rect?.width || !rect.height) return false;
      const x = Math.floor(((event.clientX - rect.left) * term.cols) / rect.width) + 1;
      const y =
        term.buffer.active.viewportY +
        Math.floor(((event.clientY - rect.top) * term.rows) / rect.height) +
        1;
      if (x < 1 || x > term.cols || event.clientY < rect.top || event.clientY >= rect.bottom)
        return false;
      return pendingLinks.some(
        ({ range }) =>
          y >= range.start.y &&
          y <= range.end.y &&
          (y !== range.start.y || x >= range.start.x) &&
          (y !== range.end.y || x <= range.end.x),
      );
    },
    provideLinks(lineNumber, callback) {
      const generation = ++requestGeneration;
      pendingLinks = [];
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
        pendingLinks = [];
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
        const candidates = [
          ...new Set(links.map((link) => terminalLinkTarget(link.text)?.value ?? "")),
        ];
        const batches: ReturnType<TerminalPathValidator>[] = [];
        for (let offset = 0; offset < candidates.length; offset += TERMINAL_PATH_BATCH_SIZE) {
          try {
            batches.push(
              validatePaths(candidates.slice(offset, offset + TERMINAL_PATH_BATCH_SIZE)),
            );
          } catch {
            batches.push([]);
          }
        }
        if (batches.every(Array.isArray)) deliver(batches.flat());
        else {
          pendingLinks = links;
          if (batches.length === 1) {
            void Promise.resolve(batches[0]).then(deliver, () => deliver([]));
            return;
          }
          void Promise.all(batches.map((batch) => Promise.resolve(batch).catch(() => []))).then(
            (results) => deliver(results.flat()),
          );
        }
      } catch {
        deliver([]);
      }
    },
  };
}
