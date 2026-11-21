// Sent over the existing bounded workspace exec transport. Identifiers arrive on stdin.
export const projectCheckoutScript = `
import fcntl, json, os, pathlib, re, shlex, shutil, subprocess, sys, tempfile

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

def verify_checkout(checkout, name, gh, env):
    require(not checkout.is_symlink() and checkout.is_dir(), "checkout_unavailable")
    require(not (checkout / ".git").is_symlink(), "checkout_unavailable")
    top = git(checkout, ["rev-parse", "--show-toplevel"], gh, env).decode().strip()
    require(top == str(checkout), "checkout_unavailable")
    remote = git(checkout, ["config", "--local", "--get", "remote.origin.url"], gh, env
                ).decode().strip().lower()
    origins = ("https://github.com/", "git@github.com:", "ssh://git@github.com/")
    require(any(remote.removesuffix(".git") == prefix + name.lower() for prefix in origins),
            "checkout_unavailable")

def main(spec):
    account, repository = spec["providerAccountId"], spec["repositoryId"]
    require(all(re.fullmatch(r"[1-9][0-9]{0,19}", x) for x in (account, repository)),
            "checkout_unavailable")
    home = pathlib.Path.home().resolve(strict=True)
    name, url, gh, env = resolve(home, account, repository)
    owner, repository_name = name.split("/")
    checkout = home / "projects" / owner / repository_name
    projects_root = pathlib.Path(spec["projectsRoot"]).resolve()
    try:
        relative_path = checkout.relative_to(projects_root)
    except ValueError:
        raise ProjectError("checkout_outside_root") from None
    require(relative_path.parts, "checkout_outside_root")

    clone_missing = spec["cloneMissing"]
    missing = {"checkout": "missing"}
    parent = home
    for part in ("projects", owner):
        parent = parent / part
        if clone_missing:
            parent.mkdir(exist_ok=True)
        elif not parent.exists() and not parent.is_symlink():
            return missing
        require(not parent.is_symlink() and parent.is_dir(), "checkout_unavailable")

    directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(directory, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ProjectError("checkout_busy")
        if checkout.exists() or checkout.is_symlink():
            verify_checkout(checkout, name, gh, env)
        elif not clone_missing:
            return missing
        else:
            with tempfile.TemporaryDirectory(dir=parent, prefix=".hive-clone-") as staging:
                stage = pathlib.Path(staging)
                prepared = stage / "checkout"
                git(stage, ["clone", "--no-recurse-submodules", "--", url, "checkout"],
                    gh, env, 75, "clone_failed")
                git(prepared, ["config", "--local", "--add", "credential.https://github.com.helper", ""],
                    gh, env)
                git(prepared, ["config", "--local", "--add", "credential.https://github.com.helper",
                               "!" + shlex.join([str(gh), "auth", "git-credential"])], gh, env)
                # Reserve the destination without replacing an existing directory.
                checkout.mkdir()
                try:
                    prepared.rename(checkout)
                except OSError:
                    try:
                        checkout.rmdir()
                    except OSError:
                        pass
                    raise
    finally:
        os.close(directory)

    return {"fullName": name, "relativePath": relative_path.as_posix()}

if __name__ == "__main__":
    try:
        response = main(json.loads(sys.stdin.buffer.read(4096)))
    except ProjectError as error:
        response = {"error": str(error)}
    except Exception:
        response = {"error": "checkout_unavailable"}
    print(json.dumps(response))
`;

export const projectCheckoutCommand = `python3 -I -c '${projectCheckoutScript.replaceAll("'", "'\\''")}'`;
