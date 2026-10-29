import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildNativeGuardian,
  guardianSourcePath,
  validateGuardianArtifact,
} from "./build-native-guardian.mjs";

test("guardian build is repeatable and rejects changed source, recipe, ELF and unsafe artifact files", () => {
  const scratch = mkdtempSync(join(tmpdir(), "hive-guardian-build-test-"));
  try {
    const root = join(scratch, "source");
    mkdirSync(join(root, "templates/ai-dev-k8s/scripts"), { recursive: true });
    const source = join(root, guardianSourcePath);
    copyFileSync(guardianSourcePath, source);
    const first = join(scratch, "first"),
      second = join(scratch, "second");
    const a = buildNativeGuardian(root, first),
      b = buildNativeGuardian(root, second);
    assert.equal(a.elfSha256, b.elfSha256);
    assert.equal(a.recipeSha256, b.recipeSha256);
    assert.throws(() => buildNativeGuardian(root, first));
    const manifestPath = join(first, "guardian-build.json"),
      binaryPath = join(first, "codex-native-guardian");
    const original = readFileSync(manifestPath),
      binary = readFileSync(binaryPath);
    chmodSync(manifestPath, 0o600);
    writeFileSync(manifestPath, JSON.stringify({ ...a, recipeSha256: "0".repeat(64) }));
    assert.throws(() => validateGuardianArtifact(root, first));
    writeFileSync(manifestPath, original);
    chmodSync(binaryPath, 0o700);
    writeFileSync(binaryPath, Buffer.concat([binary, Buffer.from("changed")]));
    assert.throws(() => validateGuardianArtifact(root, first));
    writeFileSync(binaryPath, binary);
    const originalSource = readFileSync(source);
    writeFileSync(source, Buffer.concat([originalSource, Buffer.from("\n/* changed */\n")]));
    assert.throws(() => validateGuardianArtifact(root, first));
    writeFileSync(source, originalSource);
    rmSync(binaryPath);
    symlinkSync(join(second, "codex-native-guardian"), binaryPath);
    assert.throws(() => validateGuardianArtifact(root, first));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
