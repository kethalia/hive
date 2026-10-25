import { z } from "zod";

export const cloneProjectSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(200),
    organization: z
      .string()
      .trim()
      .min(1)
      .max(39)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/, "Enter a GitHub organization or owner."),
    repository: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "Enter a repository name, without a URL or path."),
  })
  .strict();

/** Arguments are data, never shell input. Refuse existing paths and symlinked parents. */
export function cloneProjectCommand(
  root: string,
  organization: string,
  repository: string,
): string {
  const payload = Buffer.from(JSON.stringify({ root, organization, repository })).toString(
    "base64",
  );
  return `python3 - <<'HIVE_CLONE_PROJECT'\n${`
import base64, json, os, pathlib, shutil, subprocess, sys
request = json.loads(base64.b64decode("${payload}"))
root = pathlib.Path(request["root"]).resolve(strict=True)
parent = root
for part in ["projects", request["organization"]]:
    parent = parent / part
    if parent.is_symlink():
        print("unsafe-parent"); sys.exit(2)
    parent.mkdir(exist_ok=True)
    if not parent.is_dir() or not parent.resolve().is_relative_to(root):
        print("unsafe-parent"); sys.exit(2)
destination = parent / request["repository"]
try:
    destination.mkdir()
except FileExistsError:
    print("already-exists"); sys.exit(3)
try:
    result = subprocess.run(["gh", "repo", "clone", "https://github.com/" + request["organization"] + "/" + request["repository"], str(destination)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90, env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GH_PROMPT_DISABLED": "1"})
    if result.returncode != 0:
        raise RuntimeError("clone-failed")
except Exception:
    shutil.rmtree(destination)
    print("clone-failed"); sys.exit(4)
print("cloned")
`}\nHIVE_CLONE_PROJECT`;
}
