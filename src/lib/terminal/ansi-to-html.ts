import Convert from "ansi-to-html";

const decoder = new TextDecoder("utf-8", { fatal: false });

export function convertChunkToHtml(data: Uint8Array): string {
  const converter = new Convert({
    fg: "#e5e5e5",
    bg: "#0a0a0a",
    newline: true,
    escapeXML: true,
  });
  try {
    return converter.toHtml(decoder.decode(data));
  } catch {
    return decoder.decode(data);
  }
}

export function createAnsiConverter() {
  const converter = new Convert({
    fg: "#e5e5e5",
    bg: "#0a0a0a",
    newline: true,
    escapeXML: true,
    stream: true,
  });

  return {
    convert(data: Uint8Array): string {
      try {
        return converter.toHtml(decoder.decode(data));
      } catch {
        return decoder.decode(data);
      }
    },
  };
}
