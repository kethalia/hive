"""Fixed image-builder recipe. Never included in the runtime image."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent
pins = json.loads((root / "pins.json").read_text())
assert pins["go"]["version"] == "1.26.10"
assert pins["sdk"]["version"] == "v2.38.4"
env = dict(os.environ)
env.update(GOTOOLCHAIN="local", GOSUMDB="sum.golang.org", GOVCS="*:off", CGO_ENABLED="0", GOOS="linux", GOARCH="amd64", GOAMD64="v1", GOMAXPROCS="2")
go = "/opt/go/bin/go"
assert subprocess.check_output([go, "version"], env=env).strip() == b"go version go1.26.10 linux/amd64"
subprocess.run([go, "mod", "verify"], cwd=root, env=env, check=True)
subprocess.run([go, "test", "-mod=readonly", "-p=2", "-count=1", "-timeout=40s", "./..."], cwd=root, env=env, check=True)
out = Path("/out")
out.mkdir(mode=0o755)
binary = out / "hive-workspace-identity"
subprocess.run([go, "build", *pins["buildFlags"], "-o", str(binary), "."], cwd=root, env=env, check=True)
binary.chmod(0o755)
metadata = {"schemaVersion": 1, "sdkVersion": "v2.38.4", "goVersion": "go1.26.10", "sha256": hashlib.sha256(binary.read_bytes()).hexdigest()}
(out / "hive-workspace-identity.json").write_text(json.dumps(metadata, sort_keys=True, separators=(",", ":")) + "\n")
(out / "hive-workspace-identity.json").chmod(0o644)
