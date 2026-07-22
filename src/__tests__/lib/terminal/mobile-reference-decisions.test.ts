import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DOC_PATH = join(process.cwd(), "docs/mobile-terminal-reference-decisions.md");

async function readReferenceDoc() {
  return readFile(DOC_PATH, "utf8");
}

describe("mobile terminal reference decisions doc", () => {
  it("contains the required decision sections", async () => {
    const doc = await readReferenceDoc();

    expect(doc).toContain("# Mobile Terminal Reference Decisions");
    expect(doc).toContain("## Coder Terminal and Tmux Resize Observations");
    expect(doc).toContain("## Blink Mobile Terminal Affordances");
    expect(doc).toContain("## Hive Decisions");
    expect(doc).toContain("## Non-goals");
    expect(doc).toContain("## S02 Diagnostic Expectations");
  });

  it("anchors the conservative Hive decisions from D023, D026, and D030", async () => {
    const doc = await readReferenceDoc();

    expect(doc).toMatch(/D023[\s\S]*Coder/i);
    expect(doc).toMatch(/D026[\s\S]*multi-touch navigation/i);
    expect(doc).toMatch(/D030[\s\S]*xterm\/FitAddon/i);
    expect(doc).toMatch(/Keep xterm and FitAddon for now/i);
    expect(doc).toMatch(/Visible accessible controls are the baseline/i);
    expect(doc).toMatch(/Multi-touch navigation is rejected/i);
  });

  it("defines the diagnostics redaction boundary", async () => {
    const doc = await readReferenceDoc();

    const forbiddenSamples = [
      "terminal buffer text",
      "helper textarea values",
      "command input",
      "clone proof",
      "tokens",
      "secrets",
      "local filesystem paths",
    ];

    for (const phrase of forbiddenSamples) {
      expect(doc.toLowerCase()).toContain(phrase.toLowerCase());
    }

    expect(doc).toMatch(/debugViewport=1[\s\S]*non-secret geometry and state/i);
    expect(doc).toMatch(
      /must not alter auth, session selection, clone proof validation, or terminal input behavior/i,
    );
  });

  it("rejects placeholders and unresolved work markers", async () => {
    const doc = await readReferenceDoc();

    expect(doc).not.toMatch(/\b(TODO|TBD|FIXME|lorem ipsum|placeholder)\b/i);
    expect(doc).not.toContain("{{");
    expect(doc).not.toContain("}}");
  });
});
