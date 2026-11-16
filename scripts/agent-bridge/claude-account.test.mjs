import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CLAUDE_RELEASES, verifyClaudeExecutable } from "./claude-account.mjs";
import { createAccountManager, validClaudeLoginUrl } from "./codex-account.mjs";

test("Claude reuses account generation fences; a submitted code is never retained or replayed", async () => {
  const lifetimeId = randomUUID(),
    calls = [];
  let signedIn = false,
    notify;
  const manager = createAccountManager({
    provider: "claude",
    home: "/unused",
    profile: "software",
    lifetimeId,
    acquire: () => ({ fd: 3, close() {} }),
    async open(_home, _fd, event) {
      notify = event;
      calls.push("open");
      return {
        async call(method) {
          calls.push(method);
          if (method === "account/read") return { account: signedIn ? { type: "claude" } : null };
          if (method === "account/login/start")
            return {
              type: "claudeCli",
              loginId: "local-owned-cli",
              verificationUrl: "https://claude.com/cai/oauth/authorize?state=fixture",
            };
          if (method === "account/login/submitCode") return { accepted: true };
          if (method === "account/login/cancel") return { status: "canceled" };
          if (method === "account/logout") {
            signedIn = false;
            return {};
          }
          throw Error();
        },
        async close() {
          calls.push("close");
        },
      };
    },
  });
  try {
    const a = await manager.run({ action: "connect", lifetimeId, generation: 0 });
    assert.equal(a.scope, "workspace-cli");
    assert.equal(a.pending.codeSubmitted, false);
    await assert.rejects(
      manager.run({
        action: "code",
        lifetimeId: randomUUID(),
        generation: 1,
        code: "SECRET_CODE#STATE",
      }),
    );
    const submitted = await manager.run({
      action: "code",
      lifetimeId,
      generation: 1,
      code: "SECRET_CODE#STATE",
    });
    assert.equal(submitted.pending.codeSubmitted, true);
    assert.equal(JSON.stringify(submitted).includes("SECRET_CODE"), false);
    await assert.rejects(
      manager.run({ action: "code", lifetimeId, generation: 1, code: "SECRET_CODE#STATE" }),
    );
    await assert.rejects(
      manager.run({ action: "code", lifetimeId, generation: 2, code: "SECRET_CODE#STATE" }),
    );
    assert.equal(calls.filter((v) => v === "account/login/submitCode").length, 1);
    signedIn = true;
    notify({
      method: "account/login/completed",
      params: { loginId: "local-owned-cli", success: true },
    });
    const done = await manager.run({ action: "status" });
    assert.equal(done.state, "signed-in");
    const off = await manager.run({
      action: "disconnect",
      lifetimeId,
      generation: done.generation,
    });
    assert.equal(off.state, "signed-out");
    assert.ok(calls.join(",").includes("account/logout,close,open,account/read,close"));
  } finally {
    await manager.close();
  }
});
test("only the pinned CLI and official emitted login destination are accepted", async () => {
  assert.equal(validClaudeLoginUrl("https://claude.com/cai/oauth/authorize?state=fixture"), true);
  for (const url of [
    "https://evil.example/cai/oauth/authorize?state=x",
    "https://claude.com/other?state=x",
    "https://user@claude.com/cai/oauth/authorize?state=x",
    "https://claude.com/cai/oauth/authorize?state=x#fragment",
  ])
    assert.equal(validClaudeLoginUrl(url), false);
  const home = await mkdtemp(join(tmpdir(), "hive-claude-version-"));
  try {
    await mkdir(join(home, ".local/bin"), { recursive: true });
    await mkdir(join(home, ".local/share/claude/versions"), { recursive: true });
    const unknown = join(home, ".local/share/claude/versions/2.1.320");
    await writeFile(unknown, "unsupported CLI must never execute", { mode: 0o700 });
    await symlink(unknown, join(home, ".local/bin/claude"));
    assert.throws(() => verifyClaudeExecutable(home), /claude_runtime_unavailable/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Claude URL validation rejects unstripped OSC controls and duplicate links without changing encoded redirects", () => {
  const url =
    "https://claude.com/cai/oauth/authorize?state=fixture-state&code_challenge=full-pkce&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback";
  assert.equal(validClaudeLoginUrl(url), true);
  for (const code of [
    ...Array.from({ length: 32 }, (_, index) => index),
    ...Array.from({ length: 33 }, (_, index) => index + 127),
  ]) {
    const control = String.fromCharCode(code);
    assert.equal(validClaudeLoginUrl(url + control), false);
    assert.equal(validClaudeLoginUrl(url + control + url), false);
  }
  assert.equal(validClaudeLoginUrl(url + url), false);
  assert.equal(validClaudeLoginUrl(`${url}\u001b\\${url}\u001b]8;;\u001b\\`), false);
});

test("Claude 2.1.325 admission matches the verified vendor and installed executable receipt", async () => {
  const receipt = JSON.parse(
    await readFile(
      new URL(
        "../../docs/checks/workspace-accounts/claude-2.1.325-admission.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(receipt.version, "2.1.325");
  assert.equal(receipt.manifest.gpgValidSignature, true);
  assert.deepEqual(CLAUDE_RELEASES[receipt.version], {
    size: receipt.manifest.release.size,
    sha256: receipt.manifest.release.checksum,
  });
  assert.equal(receipt.installedExecutable.sha256, receipt.manifest.release.checksum);
  assert.equal(receipt.installedExecutable.bytes, receipt.manifest.release.size);
  assert.equal(receipt.admission.actualFilesystemAndHashChecks, true);
  assert.equal(receipt.protocol.cancelStatus, "canceled");
  assert.equal(receipt.protocol.loginChildExited, true);
  assert.equal(receipt.protocol.authorizationCodeSubmitted, false);
});

test("real private PTY driver bounds official commands, one-use input and child cancellation", () => {
  const result = spawnSync(
    "python3",
    ["-B", "-m", "unittest", "scripts/agents/test_claude_account_driver.py"],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
