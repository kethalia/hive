import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readFile, readdir, lstat } from "fs/promises";
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
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("bash", [SYNC_SCRIPT], { env: { ...process.env, ...env }, encoding: "utf-8" });
}

describe("sync-vault.sh", () => {
  let tempDir: string;
  let vaultDir: string;
  let agentsSrc: string;
  let claudeDir: string;
  let gsdDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sync-vault-test-"));
    vaultDir = join(tempDir, "vault");
    agentsSrc = join(vaultDir, "Agents");
    claudeDir = join(tempDir, ".claude");
    gsdDir = join(tempDir, ".gsd", "agent");
    await mkdir(agentsSrc, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── CLAUDE.md ──────────────────────────────────────────────────

  describe("CLAUDE.md sync", () => {
    it("copies CLAUDE.md from vault/Agents/ to ~/.claude/ and ~/.gsd/agent/", async () => {
      await writeFile(join(agentsSrc, "CLAUDE.md"), "# Vault CLAUDE");

      await runSync({ HOME: tempDir });

      const claudeContent = await readFile(join(claudeDir, "CLAUDE.md"), "utf-8");
      expect(claudeContent).toBe("# Vault CLAUDE");

      const gsdContent = await readFile(join(gsdDir, "CLAUDE.md"), "utf-8");
      expect(gsdContent).toBe("# Vault CLAUDE");
    });

    it("overwrites existing CLAUDE.md with vault version", async () => {
      await writeFile(join(claudeDir, "CLAUDE.md"), "# Old local version");
      await mkdir(gsdDir, { recursive: true });
      await writeFile(join(gsdDir, "CLAUDE.md"), "# Old GSD version");
      await writeFile(join(agentsSrc, "CLAUDE.md"), "# New vault version");

      await runSync({ HOME: tempDir });

      const claudeContent = await readFile(join(claudeDir, "CLAUDE.md"), "utf-8");
      expect(claudeContent).toBe("# New vault version");

      const gsdContent = await readFile(join(gsdDir, "CLAUDE.md"), "utf-8");
      expect(gsdContent).toBe("# New vault version");
    });

    it("skips CLAUDE.md when vault is missing", async () => {
      await rm(vaultDir, { recursive: true, force: true });

      const { stdout } = await runSync({ HOME: tempDir });

      expect(stdout).toContain("skipped");
    });

    it("preserves existing CLAUDE.md when vault is missing", async () => {
      await rm(vaultDir, { recursive: true, force: true });
      await writeFile(join(claudeDir, "CLAUDE.md"), "# Existing local");
      await mkdir(gsdDir, { recursive: true });
      await writeFile(join(gsdDir, "CLAUDE.md"), "# Existing GSD");

      await runSync({ HOME: tempDir });

      const claudeContent = await readFile(join(claudeDir, "CLAUDE.md"), "utf-8");
      expect(claudeContent).toBe("# Existing local");

      const gsdContent = await readFile(join(gsdDir, "CLAUDE.md"), "utf-8");
      expect(gsdContent).toBe("# Existing GSD");
    });
  });

  // ── AGENTS.md ──────────────────────────────────────────────────

  describe("AGENTS.md sync", () => {
    it("copies AGENTS.md from vault/Agents/ to ~/.claude/ and ~/.gsd/agent/", async () => {
      await writeFile(join(agentsSrc, "AGENTS.md"), "# Skill Registry");

      await runSync({ HOME: tempDir });

      const claudeContent = await readFile(join(claudeDir, "AGENTS.md"), "utf-8");
      expect(claudeContent).toBe("# Skill Registry");

      const gsdContent = await readFile(join(gsdDir, "AGENTS.md"), "utf-8");
      expect(gsdContent).toBe("# Skill Registry");
    });

    it("overwrites existing AGENTS.md with vault version", async () => {
      await writeFile(join(claudeDir, "AGENTS.md"), "# Old agents");
      await mkdir(gsdDir, { recursive: true });
      await writeFile(join(gsdDir, "AGENTS.md"), "# Old GSD agents");
      await writeFile(join(agentsSrc, "AGENTS.md"), "# Updated agents");

      await runSync({ HOME: tempDir });

      const claudeContent = await readFile(join(claudeDir, "AGENTS.md"), "utf-8");
      expect(claudeContent).toBe("# Updated agents");

      const gsdContent = await readFile(join(gsdDir, "AGENTS.md"), "utf-8");
      expect(gsdContent).toBe("# Updated agents");
    });

    it("skips AGENTS.md when vault has no Agents/AGENTS.md", async () => {
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

  // ── GSD Skills Symlink ─────────────────────────────────────────

  describe("GSD skills symlink", () => {
    it("creates symlink from ~/.gsd/agent/skills/vault to ~/.claude/skills/vault", async () => {
      const skillsDir = join(vaultDir, "Skills");
      await mkdir(join(skillsDir, "caveman"), { recursive: true });
      await writeFile(join(skillsDir, "caveman", "SKILL.md"), "# Caveman");

      await runSync({ HOME: tempDir });

      const gsdLink = join(tempDir, ".gsd", "agent", "skills", "vault");
      const claudeSkills = join(claudeDir, "skills", "vault");

      // Verify it's a symlink
      const stats = await lstat(gsdLink);
      expect(stats.isSymbolicLink()).toBe(true);

      // Verify it points to the right place
      const { readlink } = await import("fs/promises");
      const target = await readlink(gsdLink);
      expect(target).toBe(claudeSkills);

      // Verify the skill content is accessible through the symlink
      const content = await readFile(join(gsdLink, "caveman", "SKILL.md"), "utf-8");
      expect(content).toBe("# Caveman");
    });

    it("is idempotent — does not error on second run", async () => {
      const skillsDir = join(vaultDir, "Skills");
      await mkdir(join(skillsDir, "caveman"), { recursive: true });
      await writeFile(join(skillsDir, "caveman", "SKILL.md"), "# Caveman");

      await runSync({ HOME: tempDir });
      const { stdout } = await runSync({ HOME: tempDir });

      expect(stdout).toContain("GSD skills: symlink already correct");
    });

    it("skips GSD symlink when no skills were synced", async () => {
      // No Skills directory in vault
      const { stdout } = await runSync({ HOME: tempDir });

      expect(stdout).toContain("GSD skills: skipped");
    });
  });
});
