export type TerminalLinkTarget = { kind: "url" | "file"; value: string };
export type TerminalFileAction = "download" | "open" | "new-workspace";
export type TerminalPathValidator = (paths: string[]) => string[] | Promise<string[]>;
export type TerminalFileActionHandler = (path: string, action: TerminalFileAction) => void;

/** OSC 8 can contain arbitrary schemes; never turn those into browser navigation. */
export function terminalLinkTarget(uri: string): TerminalLinkTarget | null {
  if (/^https?:\/\//i.test(uri)) {
    try {
      return { kind: "url", value: new URL(uri).href };
    } catch {
      return null;
    }
  }
  let path = uri;
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      path = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[\w.-]+\.[a-z\d]+:\d+(?::\d+)?$/i.test(path)) {
    return null;
  }
  // Source locations are useful links, but File Browser needs only the filename.
  path = path.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/, "");
  if (
    !path ||
    Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return null;
  if (!path.includes("/") && !/^[\w.-]+\.[a-z\d]{1,12}$/i.test(path)) return null;
  return { kind: "file", value: path };
}

export function terminalPathMatches(text: string): { text: string; index: number }[] {
  // Delimiters exclude prose/Markdown punctuation. Paths with spaces remain supported by OSC 8.
  const tokens =
    /(?:file:\/\/[^\s<>"'`]+|(?:\/?(?:[\w.~@+-]+\/)+)[^\s<>"'`]*|[\w.-]+\.[a-zA-Z\d]{1,12}(?::\d+(?::\d+)?)?)/g;
  const matches: { text: string; index: number }[] = [];
  for (const match of text.matchAll(tokens)) {
    const before = text.slice(0, match.index);
    if (/[^\s([{"'`<]$/.test(before)) continue;
    const value = match[0].replace(/[),.;\]}]+$/, "");
    if (terminalLinkTarget(value)?.kind === "file")
      matches.push({ text: value, index: match.index });
  }
  return matches;
}
