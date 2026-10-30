"""Explicit synthetic manifest identity for isolated installer lifecycle fixtures.

The SDK/TLS and real deployment GetManifest are separate proofs. This fixture
never runs in a product bootstrap and never accepts an environment/config bypass.
It preserves the host fixture's agent ID so its unrelated signed tickets keep
matching. The read lifecycle fixture also checks a distinct normalized ID.
"""
import hashlib
import importlib.util
import json
import sys
import uuid


def fixture_normalize(config, kind):
    b = config["binding"]
    actual_agent = str(uuid.uuid5(uuid.NAMESPACE_URL, b["workspaceId"] + ":" + b["buildId"])) if kind == "workspace-read" else b["agentId"]
    evidence = {"schemaVersion": 1, "sdkVersion": "v2.38.4", "kind": kind,
                "coderOrigin": b["coderOrigin"], "workspaceId": b["workspaceId"], "buildId": b["buildId"], "appId": b["appId"], "appOrigin": b["appOrigin"], "provisionalAgentId": b["agentId"], "agentId": actual_agent}
    evidence["manifestBindingSha256"] = hashlib.sha256(json.dumps(evidence, separators=(",", ":")).encode()).hexdigest()
    evidence["helperSha256"] = "f" * 64
    normalized = json.loads(json.dumps(config))
    normalized["binding"]["agentId"] = actual_agent
    return normalized, evidence


if __name__ == "__main__":
    # Test-only wrapper around the actual installer, not an installed entrypoint.
    spec = importlib.util.spec_from_file_location("installer_under_test", sys.argv[1])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.normalize_agent_config = fixture_normalize
    try:
        print(json.dumps(module.install(json.load(sys.stdin))))
    except Exception:
        print("fixture_installer_rejected", file=sys.stderr)
        raise SystemExit(1) from None
