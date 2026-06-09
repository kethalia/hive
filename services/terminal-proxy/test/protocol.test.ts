import { describe, expect, it } from "vitest";
import { buildPtyUrl } from "../src/protocol.js";

const EXPECTED_TMUX_MENU_BINDING =
  "bind-key -n F12 display-menu -T '#S:#W' 'Copy mode' c 'copy-mode' 'Choose tree' t 'choose-tree -Zw' '' 'Split horizontal' h 'split-window -h' 'Split vertical' v 'split-window -v' 'New window' n 'new-window' 'Rename window' r 'command-prompt -I \"#W\" \"rename-window -- %%\"' '' 'Kill pane' x 'confirm-before -p \"kill-pane #P? (y/n)\" kill-pane'";
const EXPECTED_TMUX_PREFIX = `tmux -L web ${EXPECTED_TMUX_MENU_BINDING}`;

describe("buildPtyUrl", () => {
  const defaults = {
    reconnectId: "550e8400-e29b-41d4-a716-446655440000",
    width: 80,
    height: 24,
    sessionName: "my-session",
  };
  const agentId = "agent-123";

  it("constructs correct URL with all parameters including tmux command", () => {
    const url = buildPtyUrl("https://coder.example.com", agentId, defaults);
    expect(url).toContain("wss://coder.example.com/api/v2/workspaceagents/agent-123/pty?");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("reconnect")).toBe(defaults.reconnectId);
    expect(parsed.searchParams.get("width")).toBe("80");
    expect(parsed.searchParams.get("height")).toBe("24");
    expect(parsed.searchParams.get("command")).toBe(
      `${EXPECTED_TMUX_PREFIX} \\; new-session -A -s my-session \\; set status off \\; set mouse on`,
    );
  });

  it("converts http:// to ws://", () => {
    const url = buildPtyUrl("http://localhost:3000", agentId, defaults);
    expect(url).toMatch(/^ws:\/\/localhost:3000\//);
  });

  it("converts https:// to wss://", () => {
    const url = buildPtyUrl("https://coder.dev", agentId, defaults);
    expect(url).toMatch(/^wss:\/\/coder.dev\//);
  });

  it("strips trailing slash from base URL", () => {
    const url = buildPtyUrl("https://coder.dev/", agentId, defaults);
    expect(url).toContain("wss://coder.dev/api/v2/");
    expect(url).not.toContain("//api/");
  });

  it("strips multiple trailing slashes from base URL", () => {
    const url = buildPtyUrl("https://coder.dev///", agentId, defaults);
    expect(url).toContain("wss://coder.dev/api/v2/");
    expect(url).not.toContain("//api/");
  });

  it("includes tmux attach-or-create command with session name", () => {
    const url = buildPtyUrl("https://coder.dev", agentId, {
      ...defaults,
      sessionName: "dev-shell",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("command")).toBe(
      `${EXPECTED_TMUX_PREFIX} \\; new-session -A -s dev-shell \\; set status off \\; set mouse on`,
    );
  });

  it("enables tmux mouse mode and menu binding without disabling alternate screen", () => {
    const url = buildPtyUrl("https://coder.dev", agentId, defaults);
    const parsed = new URL(url);
    const command = parsed.searchParams.get("command");

    expect(command).toContain(EXPECTED_TMUX_MENU_BINDING);
    expect(command).toContain("\\; new-session -A -s my-session");
    expect(command).toContain("\\; set mouse on");
    expect(command).not.toContain("mouse off");
    expect(command).not.toContain("set-option -t");
    expect(command).not.toContain("terminal-overrides");
    expect(command).not.toContain("smcup@");
    expect(command).not.toContain("rmcup@");
  });

  it("includes shell-quoted cwd when provided", () => {
    const url = buildPtyUrl("https://coder.dev", agentId, {
      ...defaults,
      sessionName: "git-clone-deadbeef",
      cwd: "/home/coder/projects/kethalia/hive",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("command")).toBe(
      `${EXPECTED_TMUX_PREFIX} \\; new-session -A -s git-clone-deadbeef -c '/home/coder/projects/kethalia/hive' \\; set status off \\; set mouse on`,
    );
  });

  it("shell-quotes cwd with spaces and single quotes", () => {
    const url = buildPtyUrl("https://coder.dev", agentId, {
      ...defaults,
      sessionName: "git-clone-deadbeef",
      cwd: "/home/coder/projects/acme/bob's repo",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("command")).toBe(
      `${EXPECTED_TMUX_PREFIX} \\; new-session -A -s git-clone-deadbeef -c '/home/coder/projects/acme/bob'\\''s repo' \\; set status off \\; set mouse on`,
    );
  });

  it("rejects session name with spaces", () => {
    expect(() =>
      buildPtyUrl("https://coder.dev", agentId, { ...defaults, sessionName: "my session" }),
    ).toThrow(/Invalid session name/);
  });

  it("rejects session name with semicolons", () => {
    expect(() =>
      buildPtyUrl("https://coder.dev", agentId, { ...defaults, sessionName: "foo;rm -rf" }),
    ).toThrow(/Invalid session name/);
  });

  it("rejects session name with backticks", () => {
    expect(() =>
      buildPtyUrl("https://coder.dev", agentId, { ...defaults, sessionName: "`whoami`" }),
    ).toThrow(/Invalid session name/);
  });

  it("rejects empty session name", () => {
    expect(() =>
      buildPtyUrl("https://coder.dev", agentId, { ...defaults, sessionName: "" }),
    ).toThrow(/Invalid session name/);
  });

  it("rejects session name with shell pipe", () => {
    expect(() =>
      buildPtyUrl("https://coder.dev", agentId, { ...defaults, sessionName: "a|b" }),
    ).toThrow(/Invalid session name/);
  });

  it("accepts valid session names with dots, hyphens, underscores", () => {
    expect(() =>
      buildPtyUrl("https://coder.dev", agentId, { ...defaults, sessionName: "my_session.v2-beta" }),
    ).not.toThrow();
  });
});
