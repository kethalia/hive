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
  let agentsConvDir: string;
  let piDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sync-vault-test-"));
    vaultDir = join(tempDir, "vault");
    agentsSrc = join(vaultDir, "Agents");
    claudeDir = join(tempDir, ".claude");
    agentsConvDir = join(tempDir, ".agents");
    piDir = join(tempDir, ".pi", "agent");
    await mkdir(agentsSrc, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── CLAUDE.md ──────────────────────────────────────────────────

  describe("CLAUDE.md sync", () => {
    it("copies CLAUDE.md from vault/Agents/ to all three target directories", async () => {
      await writeFile(join(agentsSrc, "CLAUDE.md"), "# Vault CLAUDE");

      await runSync({ HOME: tempDir });

      const claudeContent = await readFile(join(claudeDir, "CLAUDE.md"), "utf-8");
      expect(claudeContent).toBe("# Vault CLAUDE");

      const agentsContent = await readFile(join(agentsConvDir, "CLAUDE.md"), "utf-8");
      expect(agentsContent).toBe("# Vault CLAUDE");

      const piContent = await readFile(join(piDir, "CLAUDE.md"), "utf-8");
      expect(piContent).toBe("# Vault CLAUDE");
    });

    it("overwrites existing CLAUDE.md with vault version in all targets", async () => {
      await writeFile(join(claudeDir, "CLAUDE.md"), "# Old local version");
      await mkdir(agentsConvDir, { recursive: true });
      await writeFile(join(agentsConvDir, "CLAUDE.md"), "# Old agents version");
      await mkdir(piDir, { recursive: true });
      await writeFile(join(piDir, "CLAUDE.md"), "# Old pi version");
      await writeFile(join(agentsSrc, "CLAUDE.md"), "# New vault version");

      await runSync({ HOME: tempDir });

      const claudeContent = await readFile(join(claudeDir, "CLAUDE.md"), "utf-8");
      expect(claudeContent).toBe("# New vault version");

      const agentsContent = await readFile(join(agentsConvDir, "CLAUDE.md"), "utf-8");
      expect(agentsContent).toBe("# New vault version");

      const piContent = await readFile(join(piDir, "CLAUDE.md"), "utf-8");
      expect(piContent).toBe("# New vault version");
    });

    it("skips CLAUDE.md when vault is missing", async () => {
      await rm(vaultDir, { recursive: true, force: true });

      const { stdout } = await runSync({ HOME: tempDir });

      expect(stdout).toContain("skipped");
    });

    it("preserves existing CLAUDE.md when vault is missing", async () => {
      await rm(vaultDir, { recursive: true, force: true });
      await writeFile(join(claudeDir, "CLAUDE.md"), "# Existing local");
      await mkdir(agentsConvDir, { recursive: true });
      await writeFile(join(agentsConvDir, "CLAUDE.md"), "# Existing agents");
      await mkdir(piDir, { recursive: true });
      await writeFile(join(piDir, "CLAUDE.md"), "# Existing pi");

      await runSync({ HOME: tempDir });

      const claudeContent = await readFile(join(claudeDir, "CLAUDE.md"), "utf-8");
      expect(claudeContent).toBe("# Existing local");

      const agentsContent = await readFile(join(agentsConvDir, "CLAUDE.md"), "utf-8");
      expect(agentsContent).toBe("# Existing agents");

      const piContent = await readFile(join(piDir, "CLAUDE.md"), "utf-8");
      expect(piContent).toBe("# Existing pi");
    });
  });

  // ── AGENTS.md ──────────────────────────────────────────────────

  describe("AGENTS.md sync", () => {
    it("copies AGENTS.md from vault/Agents/ to all three target directories", async () => {
      await writeFile(join(agentsSrc, "AGENTS.md"), "# Skill Registry");

      await runSync({ HOME: tempDir });

      const claudeContent = await readFile(join(claudeDir, "AGENTS.md"), "utf-8");
      expect(claudeContent).toBe("# Skill Registry");

      const agentsContent = await readFile(join(agentsConvDir, "AGENTS.md"), "utf-8");
      expect(agentsContent).toBe("# Skill Registry");

      const piContent = await readFile(join(piDir, "AGENTS.md"), "utf-8");
      expect(piContent).toBe("# Skill Registry");
    });

    it("overwrites existing AGENTS.md with vault version in all targets", async () => {
      await writeFile(join(claudeDir, "AGENTS.md"), "# Old agents");
      await mkdir(agentsConvDir, { recursive: true });
      await writeFile(join(agentsConvDir, "AGENTS.md"), "# Old conv agents");
      await mkdir(piDir, { recursive: true });
      await writeFile(join(piDir, "AGENTS.md"), "# Old pi agents");
      await writeFile(join(agentsSrc, "AGENTS.md"), "# Updated agents");

      await runSync({ HOME: tempDir });

      const claudeContent = await readFile(join(claudeDir, "AGENTS.md"), "utf-8");
      expect(claudeContent).toBe("# Updated agents");

      const agentsContent = await readFile(join(agentsConvDir, "AGENTS.md"), "utf-8");
      expect(agentsContent).toBe("# Updated agents");

      const piContent = await readFile(join(piDir, "AGENTS.md"), "utf-8");
      expect(piContent).toBe("# Updated agents");
    });

    it("skips AGENTS.md when vault has no Agents/AGENTS.md", async () => {
      await runSync({ HOME: tempDir });

      const entries = await readdir(claudeDir);
      expect(entries).not.toContain("AGENTS.md");
    });
  });

  // ── Skills ─────────────────────────────────────────────────────

  describe("Skills sync", () => {
    it("syncs skill directories from vault to all three skill targets", async () => {
      const skillsDir = join(vaultDir, "Skills");
      await mkdir(join(skillsDir, "caveman"), { recursive: true });
      await writeFile(join(skillsDir, "caveman", "SKILL.md"), "# Caveman skill");
      await mkdir(join(skillsDir, "review"), { recursive: true });
      await writeFile(join(skillsDir, "review", "SKILL.md"), "# Review skill");

      await runSync({ HOME: tempDir });

      for (const target of [
        join(claudeDir, "skills"),
        join(agentsConvDir, "skills"),
        join(piDir, "skills"),
      ]) {
        const dirs = (await readdir(target)).filter(f => !f.startsWith("."));
        expect(dirs.sort()).toEqual(["caveman", "review"]);

        const caveman = await readFile(join(target, "caveman", "SKILL.md"), "utf-8");
        expect(caveman).toBe("# Caveman skill");
      }
    });

    it("removes stale vault-managed skills no longer in vault", async () => {
      const skillsTarget = join(claudeDir, "skills");
      const target = join(skillsTarget, "old-skill");
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "SKILL.md"), "# Stale skill");
      await writeFile(join(skillsTarget, ".vault-managed"), "old-skill\n");

      const skillsDir = join(vaultDir, "Skills");
      await mkdir(join(skillsDir, "new-skill"), { recursive: true });
      await writeFile(join(skillsDir, "new-skill", "SKILL.md"), "# New skill");

      await runSync({ HOME: tempDir });

      const dirs = (await readdir(skillsTarget)).filter(f => !f.startsWith("."));
      expect(dirs).toEqual(["new-skill"]);
    });

    it("preserves user-created skills not in vault manifest", async () => {
      const skillsTarget = join(claudeDir, "skills");
      const userSkill = join(skillsTarget, "my-custom-skill");
      await mkdir(userSkill, { recursive: true });
      await writeFile(join(userSkill, "SKILL.md"), "# My custom skill");

      const skillsDir = join(vaultDir, "Skills");
      await mkdir(join(skillsDir, "vault-skill"), { recursive: true });
      await writeFile(join(skillsDir, "vault-skill", "SKILL.md"), "# Vault skill");

      await runSync({ HOME: tempDir });

      const dirs = (await readdir(skillsTarget)).filter(f => !f.startsWith("."));
      expect(dirs.sort()).toEqual(["my-custom-skill", "vault-skill"]);

      const content = await readFile(join(userSkill, "SKILL.md"), "utf-8");
      expect(content).toBe("# My custom skill");
    });

    it("updates skill content when vault version changes", async () => {
      const skillsDir = join(vaultDir, "Skills");
      const target = join(claudeDir, "skills");

      await mkdir(join(target, "caveman"), { recursive: true });
      await writeFile(join(target, "caveman", "SKILL.md"), "# Old version");

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

      for (const base of [claudeDir, agentsConvDir, piDir]) {
        const target = join(base, "skills", "shadcn");
        const skill = await readFile(join(target, "SKILL.md"), "utf-8");
        expect(skill).toBe("# shadcn");

        const nested = await readFile(join(target, "components", "button.md"), "utf-8");
        expect(nested).toBe("# Button");
      }
    });

    it("each target has its own independent .vault-managed manifest", async () => {
      const skillsDir = join(vaultDir, "Skills");
      await mkdir(join(skillsDir, "alpha"), { recursive: true });
      await writeFile(join(skillsDir, "alpha", "SKILL.md"), "# Alpha");
      await mkdir(join(skillsDir, "beta"), { recursive: true });
      await writeFile(join(skillsDir, "beta", "SKILL.md"), "# Beta");

      await runSync({ HOME: tempDir });

      for (const base of [claudeDir, agentsConvDir, piDir]) {
        const manifest = await readFile(join(base, "skills", ".vault-managed"), "utf-8");
        const entries = manifest.trim().split("\n").sort();
        expect(entries).toEqual(["alpha", "beta"]);
      }
    });

    it("stale cleanup works independently per directory", async () => {
      const skillsDir = join(vaultDir, "Skills");
      await mkdir(join(skillsDir, "keeper"), { recursive: true });
      await writeFile(join(skillsDir, "keeper", "SKILL.md"), "# Keeper");

      // Pre-populate claudeDir with a stale skill in its manifest
      const claudeSkills = join(claudeDir, "skills");
      await mkdir(join(claudeSkills, "stale-one"), { recursive: true });
      await writeFile(join(claudeSkills, "stale-one", "SKILL.md"), "# Stale");
      await writeFile(join(claudeSkills, ".vault-managed"), "stale-one\n");

      // Pre-populate agentsConvDir with a different stale skill
      const agentsSkills = join(agentsConvDir, "skills");
      await mkdir(agentsSkills, { recursive: true });
      await mkdir(join(agentsSkills, "stale-two"), { recursive: true });
      await writeFile(join(agentsSkills, "stale-two", "SKILL.md"), "# Stale two");
      await writeFile(join(agentsSkills, ".vault-managed"), "stale-two\n");

      // piDir has no stale skills (no pre-existing manifest)

      await runSync({ HOME: tempDir });

      // claudeDir: stale-one removed, keeper present
      const claudeDirs = (await readdir(claudeSkills)).filter(f => !f.startsWith("."));
      expect(claudeDirs).toEqual(["keeper"]);

      // agentsConvDir: stale-two removed, keeper present
      const agentsDirs = (await readdir(agentsSkills)).filter(f => !f.startsWith("."));
      expect(agentsDirs).toEqual(["keeper"]);

      // piDir: keeper present (no stale to remove)
      const piSkills = join(piDir, "skills");
      const piDirs = (await readdir(piSkills)).filter(f => !f.startsWith("."));
      expect(piDirs).toEqual(["keeper"]);
    });

    it("skips skills sync when vault Skills directory is missing", async () => {
      const { stdout } = await runSync({ HOME: tempDir });

      expect(stdout).toContain("skipped");
    });
  });

  // ── No symlinks ────────────────────────────────────────────────

  describe("No symlinks", () => {
    it("no symlinks exist in any target directory after sync", async () => {
      const skillsDir = join(vaultDir, "Skills");
      await mkdir(join(skillsDir, "caveman"), { recursive: true });
      await writeFile(join(skillsDir, "caveman", "SKILL.md"), "# Caveman");
      await writeFile(join(agentsSrc, "CLAUDE.md"), "# CLAUDE");
      await writeFile(join(agentsSrc, "AGENTS.md"), "# AGENTS");

      await runSync({ HOME: tempDir });

      async function assertNoSymlinks(dir: string, isRoot = false): Promise<void> {
        let entries: string[];
        try {
          entries = await readdir(dir);
        } catch (err) {
          if (isRoot) throw err;
          return;
        }
        for (const entry of entries) {
          const fullPath = join(dir, entry);
          const stats = await lstat(fullPath);
          expect(stats.isSymbolicLink()).toBe(false);
          if (stats.isDirectory()) {
            await assertNoSymlinks(fullPath);
          }
        }
      }

      await assertNoSymlinks(claudeDir, true);
      await assertNoSymlinks(agentsConvDir, true);
      await assertNoSymlinks(piDir, true);
    });
  });
});
