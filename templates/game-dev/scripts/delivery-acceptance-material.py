#!/usr/bin/env python3
"""Read-only, fixed published broker material. No caller paths or provider calls."""
import importlib.util
import json
import os
from pathlib import Path
import pwd
import sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("acceptance_objects", Path(__file__).with_name("delivery-source-apply-worker.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def read_candidate(source, home):
    module.require(isinstance(source, dict) and isinstance(source.get("accepted"), dict), "acceptance_material_invalid")
    reader = module.PublishedObjects(home, source["accepted"]["operationId"])
    try:
        reader.bind(source)
        entry = reader.signed(reader.root / "operations" / (reader.operation_id + ".json"))
        contents, total = [], 0
        for item in entry["manifest"]:
            total += item["size"]
            module.require(total <= 131072, "acceptance_context_limit")
            raw = module.broker.read_private(reader.root / "sealed" / item["contentDigest"], 131072)
            module.require(len(raw) == item["size"] and module.sha(raw) == item["contentDigest"] and module.broker.object_id("blob", raw) == item["blobSha"], "acceptance_material_changed")
            text = raw.decode("utf-8", errors="strict")
            module.require("\0" not in text, "acceptance_binary_context")
            contents.append({"path": item["path"], "text": text})
        candidate = {"manifest": {"files": entry["manifest"], "deletions": sorted(entry["request"]["deletions"])}, "contents": contents}
        module.require(len(module.canonical(candidate)) <= 200000, "acceptance_context_limit")
        reader.bind(source)
        return candidate
    finally:
        reader.close()

if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(65537)
        module.require(len(raw) <= 65536, "acceptance_material_limit")
        source = json.loads(raw)
        value = read_candidate(source, Path(pwd.getpwuid(os.getuid()).pw_dir))
        sys.stdout.buffer.write(module.canonical(value))
    except Exception:
        sys.exit(1)
