import { describe, expect, it } from "vitest";
import {
  type CommandSearchDocument,
  matchesProjectSearch,
  rankCommandGroups,
  scoreCommand,
} from "@/lib/terminal/command-search";

const settings = {
  label: "Settings",
  group: "Hive",
  aliases: ["preferences", "configuration"],
  description: "Account, app updates, and notifications",
};
const desktop = {
  label: "Desktop",
  group: "Desktops",
  value: "Desktop creator-direction-upgrade desktop app",
};
const stopped = {
  label: "Start nextcloud-cookbook-infra",
  group: "Workspaces",
  value: "nextcloud-cookbook-infra stopped start workspace terminals repositories agents",
};
const visible = (documents: CommandSearchDocument[], query: string) =>
  rankCommandGroups(documents, query).flatMap(([, items]) =>
    items.filter((item) => scoreCommand(item, query) > 0),
  );

describe("launcher search relevance", () => {
  it("excludes the screenshot's scattered-letter matches and puts Settings first", () => {
    expect(visible([desktop, stopped, settings], "settings")).toEqual([settings]);
    expect(visible([desktop, stopped, settings], "setting")).toEqual([settings]);
  });

  it("ranks exact names above prefixes, contained phrases, aliases, categories, and context", () => {
    const documents = [
      { label: "Inspector", group: "Tools", description: "settings" },
      { label: "Account", group: "Settings" },
      { label: "Preferences", group: "Hive", aliases: ["settings"] },
      { label: "Workspace settings", group: "Commands" },
      { label: "Settings backup", group: "Commands" },
      settings,
    ];
    const scores = documents.map((document) => scoreCommand(document, "settings"));
    expect(scores.every((score, index) => index === 0 || score > scores[index - 1])).toBe(true);
    expect(visible(documents, "settings")[0]).toEqual(settings);
  });

  it.each([
    "preferences",
    "PREFERENCES",
    "config",
    "notif",
    "settigns",
    "setings",
    "settinxs",
    "settingss",
  ])("finds a name, alias, description, or single typo: %s", (query) => {
    expect(visible([desktop, stopped, settings], query)).toEqual([settings]);
  });

  it("requires every word and uses workspace context to disambiguate apps", () => {
    const editor = {
      label: "VS Code",
      group: "VS Code",
      aliases: ["vscode", "editor"],
      description: "ai-dev-01",
    };
    const otherEditor = { ...editor, description: "browser-helper" };
    expect(visible([otherEditor, desktop, editor], "editor ai dev")).toEqual([editor]);
    expect(visible([otherEditor, editor], "editor missing")).toEqual([]);
    expect(scoreCommand(editor, "vscode")).toBeGreaterThan(0);
  });

  it("normalizes accents and separators without fuzzy matching metadata", () => {
    expect(scoreCommand({ label: "Café tools", group: "Hive" }, "CAFE-tools")).toBe(1);
    expect(scoreCommand(settings, "notificatons")).toBe(0);
    expect(scoreCommand(stopped, "sttings")).toBe(0);
    expect(scoreCommand(settings, "sttgs")).toBe(0);
    expect(scoreCommand(desktop, "settings")).toBe(0);
  });

  it("prefers real session names over agent aliases", () => {
    const agent = { label: "Agents", group: "Hive", aliases: ["codex", "claude"] };
    const session = { label: "codex", group: "Terminals" };
    expect(visible([agent, session], "codex")).toEqual([session, agent]);
  });

  it("keeps creation first for category browsing, and preserves empty-query order", () => {
    const actions = [
      { label: "New session", group: "Terminals" },
      { label: "codex", group: "Terminals" },
      { label: "New project", group: "Projects" },
      { label: "hive", group: "Projects" },
      settings,
    ];
    expect(visible(actions, "")).toEqual(actions);
    expect(visible(actions, "terminals")).toEqual(actions.slice(0, 2));
    expect(visible(actions, "projects")).toEqual(actions.slice(2, 4));
  });

  it("orders groups by their best match, with stable order for equal scores", () => {
    const actions = [
      { label: "Files", group: "Files", description: "hive" },
      { label: "hive-cache", group: "Projects" },
      { label: "hive", group: "Terminals", description: "first-workspace" },
      { label: "hive", group: "Terminals", description: "second-workspace" },
    ];
    expect(visible(actions, "hive")).toEqual([actions[2], actions[3], actions[1], actions[0]]);
  });
});

describe("project search", () => {
  it.each([
    "",
    "hive",
    "HIVE",
    "projects",
    "project hive",
    "projects hive cache",
    "kethalia/HIVE",
  ])("matches a literal name/path with an optional category: %s", (query) => {
    expect(matchesProjectSearch("hive-cache", "projects/kethalia/hive-cache", query)).toBe(true);
  });
  it.each([
    "settings",
    "ai-dev-01",
    "hvie",
    "projects unrelated",
    "hive missing",
  ])("excludes unrelated names: %s", (query) => {
    expect(matchesProjectSearch("hive-cache", "projects/kethalia/hive-cache", query)).toBe(false);
  });
});
