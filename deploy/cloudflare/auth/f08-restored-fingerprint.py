#!/usr/bin/env python3
"""Read-only original-column fingerprints; row bytes never leave this process."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.parse import urlsplit


def run(owner_file, capture_file, dump_file, fixture_id=None):
    spec = importlib.util.spec_from_file_location("capture", "scripts/checks/data-migration/capture.py")
    capture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(capture)
    url = capture.connection(Path(owner_file))
    parsed = urlsplit(url)
    host_digest = hashlib.sha256(parsed.hostname.replace("-pooler.", ".").encode()).hexdigest()
    if parsed.path != "/hive_production_rehearsal_20261105" or host_digest != "0c2e055f1031ffce660a74f2483fadcbf7a15033a61f4158dc5f3c3c8e8cd933":
        raise ValueError("f08_database_scope")
    if fixture_id and not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}", fixture_id):
        raise ValueError("f08_fixture_id_invalid")
    metadata = json.loads(Path(capture_file).read_text())
    if set(metadata["tables"]) != {"_prisma_migrations", "users", "sessions", "coder_tokens", "navigation_favorites", "notification_sources", "push_subscriptions", "vapid_keys"}:
        raise ValueError("f08_capture_scope")
    raw = subprocess.check_output(["pg_restore", "--data-only", "--table", "_prisma_migrations", "--file", "-", str(dump_file)], stderr=subprocess.DEVNULL, text=True, timeout=30)
    ids, inside = [], False
    for line in raw.splitlines():
        if line.startswith("COPY public._prisma_migrations "):
            inside = True
        elif inside and line == "\\.":
            inside = False
        elif inside:
            identifier = line.split("\t")[0]
            if not re.fullmatch(r"[a-f0-9-]{36}", identifier): raise ValueError("f08_migration_id_invalid")
            ids.append(identifier)
    if len(ids) != metadata["tables"]["_prisma_migrations"]["count"]: raise ValueError("f08_migration_ids_changed")
    snapshot = capture.Snapshot(capture.environment(url), 90, time.monotonic()+90)
    snapshot.one("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();")
    try:
        result = {}
        for name, table in metadata["tables"].items():
            columns=",".join(capture.identifier(v) for v in table["columns"])
            where=""
            if name=="_prisma_migrations": where=" WHERE id IN ("+",".join("'"+i+"'" for i in ids)+")"
            elif fixture_id and name=="users": where=" WHERE id <> '"+fixture_id+"'::uuid"
            elif fixture_id and name in ("sessions","coder_tokens"): where=" WHERE user_id <> '"+fixture_id+"'::uuid"
            sql="SELECT row_to_json(t)::text FROM (SELECT "+columns+" FROM ONLY public."+capture.identifier(name)+where+") t ORDER BY row_to_json(t)::text COLLATE \"C\";"
            digest,count=hashlib.sha256(),0
            for row in snapshot.rows(sql):
                encoded=row.encode();digest.update(len(encoded).to_bytes(8,"big"));digest.update(encoded);count+=1
            result[name]={"count":count,"sha256":digest.hexdigest(),"matches":count==table["count"] and digest.hexdigest()==table["sha256"]}
        if not all(row["matches"] for row in result.values()): raise ValueError("f08_original_rows_changed")
        return result
    finally:
        snapshot.close()

if __name__=="__main__":
    if len(sys.argv) not in (4,5): raise SystemExit("usage: f08-restored-fingerprint.py <owner-file> <capture-file> <dump-file> [fixture-id]")
    print(json.dumps(run(*sys.argv[1:]),sort_keys=True))
