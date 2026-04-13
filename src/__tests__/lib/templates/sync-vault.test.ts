import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readFile, readdir, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const SYNC_SCRIPT = join(
  process.cwd(),
  "templates",
  "hive",
  "scripts",
  "sync-vault.sh"
);

async function runSync(
  env: Record<string, string>,
  fallbackArg?: string
): Promise<{ stdout: string; stderr: string }> {
  const args = [SYNC_SCRIPT];
  if (fallbackArg) args.push(fallbackArg);
  return execFileAsync("bash", args, { env: { ...process.env, ...env } });
}

describe("sync-vault.sh", () => {
  let tempDir: string;
  let vaultDir: string;
  let claudeDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sync-vault-test-"));
    vaultDir = join(tempDir, "vault");
    claudeDir = join(tempDir, ".claude");
    await mkdir(vaultDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── CLAUDE.md ──────────────────────────────────────────────────

  describe("CLAUDE.md sync", () => {
    it("copies CLAUDE.md from vault to ~/.claude/", async () => {
      await writeFile(join(vaultDir, "CLAUDE.md"), "# Vault CLAUDE");

      await runSync({ HOME: tempDir });

      const content = await readFile(join(claudeDir, "CLAUDE.md"), "utf-8");
      expect(content).toBe("# Vault CLAUDE");
    });

    it("overwrites existing CLAUDE.md with vault version", async () => {
      await writeFile(join(claudeDir, "CLAUDE.md"), "# Old local version");
      await writeFile(join(vaultDir, "CLAUDE.md"), "# New vault version");

      await runSync({ HOME: tempDir });

      const content = await readFile(join(claudeDir, "CLAUDE.md"), "utf-8");
      expect(content).toBe("# New vault version");
    });

    it("uses fallback content when vault is missing and no local copy exists", async () => {
      // Remove vault dir to simulate vault not cloned yet
      await rm(vaultDir, { recursive: true, force: true });
      // Remove the claude dir so it gets recreated
      await rm(claudeDir, { recursive: true, force: true });

      await runSync({ HOME: tempDir }, "# Fallback content");

      const content = await readFile(join(claudeDir, "CLAUDE.md"), "utf-8");
      expect(content.trim()).toBe("# Fallback content");
    });

    it("preserves existing CLAUDE.md when vault is missing", async () => {
      await rm(vaultDir, { recursive: true, force: true });
      await writeFile(join(claudeDir, "CLAUDE.md"), "# Existing local");

      await runSync({ HOME: tempDir });

      const content = await readFile(join(claudeDir, "CLAUDE.md"), "utf-8");
      expect(content).toBe("# Existing local");
    });
  });

  // ── AGENTS.md ──────────────────────────────────────────────────

  describe("AGENTS.md sync", () => {
    it("copies AGENTS.md from vault to ~/.claude/", async () => {
      await writeFile(join(vaultDir, "AGENTS.md"), "# Skill Registry");

      await runSync({ HOME: tempDir });

      const content = await readFile(join(claudeDir, "AGENTS.md"), "utf-8");
      expect(content).toBe("# Skill Registry");
    });

    it("overwrites existing AGENTS.md with vault version", async () => {
      await writeFile(join(claudeDir, "AGENTS.md"), "# Old agents");
      await writeFile(join(vaultDir, "AGENTS.md"), "# Updated agents");

      await runSync({ HOME: tempDir });

      const content = await readFile(join(claudeDir, "AGENTS.md"), "utf-8");
      expect(content).toBe("# Updated agents");
    });

    it("skips AGENTS.md when vault has no AGENTS.md", async () => {
      // No AGENTS.md in vault, and none locally
      await runSync({ HOME: tempDir });

      const entries = await readdir(claudeDir);
      expect(entries).not.toContain("AGENTS.md");
    });
  });

  // ── Skills ─────────────────────────────────────────────────────

  describe("Skills sync", () => {
    it("syncs skill directories from vault to ~/.claude/skills/vault/", async () => {
      const skillsDir = join(vaultDir, "Skills");
      await mkdir(join(skillsDir, "caveman"), { recursive: true });
      await writeFile(join(skillsDir, "caveman", "SKILL.md"), "# Caveman skill");
      await mkdir(join(skillsDir, "review"), { recursive: true });
      await writeFile(join(skillsDir, "review", "SKILL.md"), "# Review skill");

      await runSync({ HOME: tempDir });

      const target = join(claudeDir, "skills", "vault");
      const dirs = await readdir(target);
      expect(dirs.sort()).toEqual(["caveman", "review"]);

      const caveman = await readFile(join(target, "caveman", "SKILL.md"), "utf-8");
      expect(caveman).toBe("# Caveman skill");
    });

    it("removes stale skills no longer in vault", async () => {
      // Pre-populate a local skill that doesn't exist in vault
      const target = join(claudeDir, "skills", "vault", "old-skill");
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "SKILL.md"), "# Stale skill");

      // Vault has only one skill
      const skillsDir = join(vaultDir, "Skills");
      await mkdir(join(skillsDir, "new-skill"), { recursive: true });
      await writeFile(join(skillsDir, "new-skill", "SKILL.md"), "# New skill");

      await runSync({ HOME: tempDir });

      const vaultSkillsDir = join(claudeDir, "skills", "vault");
      const dirs = await readdir(vaultSkillsDir);
      expect(dirs).toEqual(["new-skill"]);
    });

    it("updates skill content when vault version changes", async () => {
      const skillsDir = join(vaultDir, "Skills");
      const target = join(claudeDir, "skills", "vault");

      // Pre-populate with old content
      await mkdir(join(target, "caveman"), { recursive: true });
      await writeFile(join(target, "caveman", "SKILL.md"), "# Old version");

      // Vault has updated content
      await mkdir(join(skillsDir, "caveman"), { recursive: true });
      await writeFile(join(skillsDir, "caveman", "SKILL.md"), "# Updated version");

      await runSync({ HOME: tempDir });

      const content = await readFile(join(target, "caveman", "SKILL.md"), "utf-8");
      expect(content).toBe("# Updated version");
    });

    it("handles skills with nested subdirectories", async () => {
      const skillsDir = join(vaultDir, "Skills");
      await mkdir(join(skillsDir, "shadcn", "components"), { recursive: true });
      await writeFile(join(skillsDir, "shadcn", "SKILL.md"), "# shadcn");
      await writeFile(join(skillsDir, "shadcn", "components", "button.md"), "# Button");

      await runSync({ HOME: tempDir });

      const target = join(claudeDir, "skills", "vault", "shadcn");
      const skill = await readFile(join(target, "SKILL.md"), "utf-8");
      expect(skill).toBe("# shadcn");

      const nested = await readFile(join(target, "components", "button.md"), "utf-8");
      expect(nested).toBe("# Button");
    });

    it("skips skills sync when vault Skills directory is missing", async () => {
      // Vault exists but has no Skills directory
      const { stdout } = await runSync({ HOME: tempDir });

      expect(stdout).toContain("skipped");
    });
  });
});
