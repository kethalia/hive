import { execFileSync } from "node:child_process";

const sha = /^[a-f0-9]{40}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const unavailableProviderBuild = Object.freeze({
  schemaVersion: 1,
  status: "unavailable",
  reason: "non_provider_build",
});
export function verifyProviderBuildIdentity(env, checkout) {
  if (env.WORKERS_CI !== "1") return unavailableProviderBuild;
  if (
    !checkout?.clean ||
    !sha.test(checkout.sha) ||
    env.WORKERS_CI_COMMIT_SHA !== checkout.sha ||
    !uuid.test(env.WORKERS_CI_BUILD_UUID ?? "") ||
    typeof env.WORKERS_CI_BRANCH !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(env.WORKERS_CI_BRANCH) ||
    env.WORKERS_CI_BRANCH.includes("..") ||
    env.WORKERS_CI_BRANCH.includes("//")
  )
    throw Error("provider_build_identity_unverified");
  return {
    schemaVersion: 1,
    status: "available",
    provider: "cloudflare-builds",
    sourceSha: checkout.sha,
    buildUuid: env.WORKERS_CI_BUILD_UUID,
    branch: env.WORKERS_CI_BRANCH,
  };
}
export function readProviderBuildIdentity(env = process.env, root = process.cwd()) {
  if (env.WORKERS_CI !== "1") return unavailableProviderBuild;
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  return verifyProviderBuildIdentity(env, {
    sha: git("rev-parse", "HEAD"),
    clean: !git("status", "--porcelain", "--untracked-files=no"),
  });
}
