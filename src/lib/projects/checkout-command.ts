// Sent over the existing bounded workspace exec transport. Identifiers arrive on stdin.
export const projectCheckoutScript = String.raw`
import fcntl, hashlib, json, os, pathlib, re, shlex, shutil, subprocess, sys, tempfile, time

class ProjectError(Exception):
    pass

def require(condition, code):
    if not condition:
        raise ProjectError(code)

def run(args, cwd=None, env=None, timeout=12, code="checkout_unavailable"):
    result = subprocess.run(args, cwd=cwd, env=env, timeout=timeout, check=False,
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    require(result.returncode == 0 and len(result.stdout) <= 1048576, code)
    return result.stdout

def private_directory(path):
    path.mkdir(mode=0o700, exist_ok=True)
    require(not path.is_symlink() and path.is_dir() and path.stat().st_uid == os.getuid(),
            "checkout_unavailable")
    return path

def resolve(root, account, repository):
    gh = root / ".local/libexec/gh"
    if not gh.is_file():
        gh = shutil.which("gh", path="/usr/local/bin:/usr/bin:/bin")
    require(gh, "github_unavailable")
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(root),
           "GH_PROMPT_DISABLED": "1", "GH_NO_UPDATE_NOTIFIER": "1"}
    token = run([str(gh), "auth", "token", "--hostname", "github.com"], env=env, timeout=8,
                code="github_unavailable").decode("ascii").strip()
    require(re.fullmatch(r"[A-Za-z0-9._~-]{1,4096}", token), "github_unavailable")
    env["GH_TOKEN"] = token
    def api(endpoint):
        return json.loads(run([str(gh), "api", "--hostname", "github.com", endpoint],
                              env=env, timeout=8, code="github_unavailable"))
    require(str(api("user").get("id")) == account, "github_account_changed")
    repo = api("repositories/" + repository)
    name = repo.get("full_name", "")
    require(str(repo.get("id")) == repository and
            re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}", name) and
            name.split("/", 1)[1] not in (".", "..") and
            repo.get("permissions", {}).get("pull") is True, "github_unavailable")
    url = "https://github.com/" + name + ".git"
    require(repo.get("clone_url") == url, "github_unavailable")
    return name, url, gh, env

def git(cwd, args, gh, env, timeout=12, code="checkout_unavailable"):
    return run(["git", "-c", "credential.helper=", "-c",
                "credential.helper=!" + shlex.join([str(gh), "auth", "git-credential"]),
                "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
                "-c", "http.followRedirects=false", "-c", "protocol.file.allow=never",
                "-c", "protocol.ext.allow=never", "-c", "init.templateDir=", *args],
               cwd, {**env, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
                     "GIT_TERMINAL_PROMPT": "0", "GIT_LFS_SKIP_SMUDGE": "1"}, timeout, code)

def process_uses(path, process):
    prefix = str(path) + "/"
    def inside(target):
        return target == str(path) or target.startswith(prefix)
    for attempt in range(3):
        try:
            status = (process / "status").read_text(errors="surrogateescape").splitlines()
            uids = next(line.split()[1:] for line in status if line.startswith("Uid:"))
            if str(os.getuid()) not in uids:
                return False
            state = next(line.split()[1] for line in status if line.startswith("State:"))
            if state in ("Z", "X"):
                return False
            for entry in (process / "cwd", process / "exe", *(process / "fd").iterdir()):
                try:
                    if inside(os.readlink(entry).removesuffix(" (deleted)")):
                        return True
                except FileNotFoundError:
                    continue
            for line in (process / "maps").read_text(errors="surrogateescape").splitlines():
                fields = line.split(maxsplit=5)
                if len(fields) == 6 and inside(fields[5].removesuffix(" (deleted)")):
                    return True
            return False
        except (FileNotFoundError, ProcessLookupError):
            return False
        except PermissionError:
            # An exec can briefly make procfs links unreadable. A persistent
            # inspection failure must keep the checkout.
            if attempt == 2:
                raise ProjectError("cleanup_unverified")
            time.sleep(0.05)

def in_use(path, proc_root=pathlib.Path("/proc")):
    for process in proc_root.iterdir():
        if process.name.isdecimal() and process_uses(path, process):
            return True
    for line in (proc_root / "self/mountinfo").read_text().splitlines():
        mount = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), line.split()[4])
        if mount == str(path) or mount.startswith(str(path) + "/"):
            return True
    return False

def audio_environment(session):
    helper = shutil.which("hive-audio")
    if not helper:
        return []
    try:
        pulse = run([helper, "prepare", "--", session], timeout=8).decode().strip()
    except (OSError, ProjectError, subprocess.TimeoutExpired, UnicodeError):
        return []
    if not re.fullmatch(r"unix:/[^\r\n\x00]+", pulse):
        return []
    return ["-e", "PULSE_SERVER=" + pulse]

# Runs inside tmux so dependency progress and errors stay visible across browser disconnects.
LAUNCH = """
import hashlib, json, os, pathlib, shutil, subprocess, sys

def prepare():
    root = pathlib.Path.cwd()
    manifest = root / "package.json"
    if not manifest.is_file() or manifest.is_symlink():
        return
    commands = {
        "pnpm": (("pnpm-lock.yaml",), ["install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"]),
        "npm": (("package-lock.json", "npm-shrinkwrap.json"), ["ci", "--ignore-scripts"]),
        "yarn": (("yarn.lock",), ["install", "--immutable", "--mode=skip-build"]),
        "bun": (("bun.lock", "bun.lockb"), ["install", "--frozen-lockfile", "--ignore-scripts"]),
    }
    data = json.loads(manifest.read_text())
    pinned = data.get("packageManager", "")
    candidates = [(manager, root / lock, args) for manager, (locks, args) in commands.items()
                  for lock in locks if (root / lock).is_file() and not (root / lock).is_symlink()]
    candidate = next((entry for entry in candidates if entry[0] == pinned.split("@", 1)[0]), None)
    if not candidate and len(candidates) == 1:
        candidate = candidates[0]
    if not candidate:
        if candidates:
            print("Multiple package managers found. Install dependencies from the Codex terminal.", flush=True)
        return
    manager, lock, args = candidate
    if manager == "yarn" and (pinned.startswith("yarn@1.") or lock.read_bytes().startswith(b"# THIS IS AN AUTOGENERATED FILE")):
        args = ["install", "--frozen-lockfile", "--ignore-scripts"]
    files = [manifest, lock, root / "pnpm-workspace.yaml", root / ".npmrc", root / ".yarnrc.yml"]
    digest = hashlib.sha256()
    for file in files:
        if file.is_file() and not file.is_symlink():
            digest.update(file.name.encode() + bytes([0]) + file.read_bytes())
    fingerprint = digest.hexdigest()
    stamp = root.parent / "dependencies"
    if stamp.is_file() and not stamp.is_symlink() and stamp.read_text() == fingerprint and (
        (root / "node_modules").is_dir() or (root / ".pnp.cjs").is_file()
    ):
        return
    print("Installing locked dependencies with " + manager + "…", flush=True)
    env = {**os.environ, "CI": "true", "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0",
           "YARN_ENABLE_SCRIPTS": "false", "YARN_IGNORE_PATH": "1"}
    env.pop("GH_TOKEN", None)
    env.pop("GITHUB_TOKEN", None)
    binary = shutil.which(manager)
    if not binary or subprocess.run([binary, *args], env=env, check=False, timeout=600).returncode != 0:
        print("Dependency setup did not finish. You can retry from Projects after closing this session.", flush=True)
        return
    temporary = stamp.with_suffix(".new")
    with temporary.open("x") as stream:
        stream.write(fingerprint)
    os.replace(temporary, stamp)

try:
    prepare()
except Exception:
    print("Dependency setup could not be verified. Review the checkout from Codex.", flush=True)
print("Opening Codex in " + str(pathlib.Path.cwd()), flush=True)
os.environ.pop("GH_TOKEN", None)
os.environ.pop("GITHUB_TOKEN", None)
os.execv(sys.argv[1], [sys.argv[1]])
"""

def main(spec):
    action, account, repository = spec["action"], spec["providerAccountId"], spec["repositoryId"]
    require(action in ("open", "cleanup") and all(re.fullmatch(r"[1-9][0-9]{0,19}", x)
            for x in (account, repository)), "checkout_unavailable")
    home = pathlib.Path.home().resolve(strict=True)
    name, url, gh, env = resolve(home, account, repository)
    root = home
    for part in (".local", "share", "hive", "project-checkouts"):
        root = private_directory(root / part)
    require(root.stat().st_mode & 0o077 == 0, "checkout_unavailable")
    key = account + "-" + repository
    session = "hive-project-" + hashlib.sha256(key.encode()).hexdigest()[:32]
    tmux = ["tmux", "-L", "web"]
    project = root / key
    checkout = project / "checkout"
    record = project / "project.json"
    lock = os.open(root / (key + ".lock"), os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock, "w") as guard:
        try:
            fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ProjectError("checkout_busy")
        if project.exists() or project.is_symlink():
            require(not project.is_symlink() and not checkout.is_symlink() and not record.is_symlink()
                    and project.is_dir() and checkout.is_dir() and (checkout / ".git").is_dir()
                    and not (checkout / ".git").is_symlink() and record.is_file()
                    and record.stat().st_size < 2048, "checkout_unavailable")
            saved = json.loads(record.read_text())
            require(saved == {"account": account, "repository": repository, "url": saved.get("url")}
                    and re.fullmatch(r"https://github\.com/[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}\.git",
                                     saved["url"])
                    and git(checkout, ["remote", "get-url", "origin"], gh, env).decode().strip()
                    == saved["url"], "checkout_unavailable")
            require(git(checkout, ["rev-parse", "--show-toplevel"], gh, env).decode().strip() == str(checkout),
                    "checkout_unavailable")
        elif action == "cleanup":
            return {"status": "absent"}
        else:
            with tempfile.TemporaryDirectory(dir=root, prefix=".clone-") as staging:
                stage = pathlib.Path(staging)
                git(stage, ["clone", "--no-recurse-submodules", "--", url, "checkout"], gh, env, 75,
                    "clone_failed")
                git(stage / "checkout", ["config", "--local", "--add",
                                         "credential.https://github.com.helper", ""], gh, env)
                git(stage / "checkout", ["config", "--local", "--add",
                                         "credential.https://github.com.helper",
                                         "!" + shlex.join([str(gh), "auth", "git-credential"])], gh, env)
                (stage / "project.json").write_text(json.dumps({"account": account,
                                                               "repository": repository, "url": url}))
                stage.rename(project)
        active = subprocess.run([*tmux, "has-session", "-t", "=" + session], timeout=5,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        if action == "open":
            if not active:
                codex = shutil.which("codex")
                require(codex, "codex_unavailable")
                run([*tmux, "new-session", "-d", "-s", session, "-c", str(checkout),
                     *audio_environment(session), shlex.join([sys.executable, "-c", LAUNCH, codex])],
                    code="codex_unavailable")
            return {"status": "opened", "sessionName": session, "fullName": name}
        require(not active and not in_use(project), "checkout_in_use")
        require(git(checkout, ["worktree", "list", "--porcelain"], gh, env).count(b"worktree ") == 1,
                "checkout_in_use")
        require(not any(entry and (entry[:1] == b"S" or entry[:1].islower()) for entry in
                        git(checkout, ["ls-files", "-v", "-z"], gh, env).split(bytes([0]))),
                "checkout_dirty")
        changes = git(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=normal",
                                 "--ignored=matching", "--ignore-submodules=none"], gh, env).split(bytes([0]))
        allowed = (b"/node_modules/", b" node_modules/")
        require(not any(line and not (line.startswith(b"!! ") and line.endswith(allowed))
                        for line in changes), "checkout_dirty")
        # Query current remote refs; stale tracking refs cannot authorize deletion.
        git(checkout, ["fetch", "--prune", "--no-tags", "--", url,
                       "+refs/heads/*:refs/remotes/origin/*"], gh, env, 45, "cleanup_unverified")
        require(not git(checkout, ["rev-list", "--all", "--reflog", "--not", "--remotes=origin"], gh, env),
                "checkout_unpublished")
        require(not in_use(project), "checkout_in_use")
        shutil.rmtree(project)
        return {"status": "removed"}

if __name__ == "__main__":
    try:
        response = main(json.loads(sys.stdin.buffer.read(4096)))
    except ProjectError as error:
        response = {"error": str(error)}
    except Exception:
        response = {"error": "checkout_unavailable"}
    print(json.dumps(response))
`;

export const projectCheckoutCommand = `python3 -c '${projectCheckoutScript.replaceAll("'", "'\\''")}'`;
