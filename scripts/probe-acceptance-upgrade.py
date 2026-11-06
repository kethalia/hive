#!/usr/bin/env python3
"""Read-only deterministic fingerprints of a task-owned local migration fixture."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

parser=argparse.ArgumentParser();parser.add_argument("--database",required=True);parser.add_argument("--port",required=True,type=int);parser.add_argument("--output",required=True)
args=parser.parse_args()
if not re.fullmatch(r"hive_acceptance_test_upgrade[a-z0-9_]*",args.database) or not 1024<=args.port<=65535:raise SystemExit("Private fixture only")
def sql(statement):
    return subprocess.check_output(["/usr/bin/psql","-X","-h","127.0.0.1","-p",str(args.port),"-U","coder","-d",args.database,"-At","-v","ON_ERROR_STOP=1","-c",statement],env={"PATH":"/usr/bin:/bin","LANG":"C.UTF-8"},text=True,timeout=20).strip()
tables=sql("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename").splitlines()
result={"schemaVersion":1,"fixture":args.database,"tables":{},"migrations":json.loads(sql("SELECT coalesce(json_object_agg(migration_name,checksum ORDER BY migration_name),'{}'::json) FROM _prisma_migrations WHERE finished_at IS NOT NULL")),"restrictedRole":{}}
for name in tables:
    if not re.fullmatch(r"[a-z_]+",name):raise SystemExit("Unexpected fixture identifier")
    raw=sql('SELECT count(*)::text || \'/\' || md5(coalesce(string_agg(row_to_json(t)::text, E\'\\n\' ORDER BY row_to_json(t)::text),\'\')) FROM "'+name+'" t')
    result["tables"][name]={"rows":int(raw.split('/')[0]),"digest":raw.split('/')[1]}
if sql("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hive_app_runtime')")=='t':
    for table in ['delivery_acceptance_intents','delivery_acceptance_jobs','delivery_acceptance_plans']:
        if table in tables:result['restrictedRole'][table]={permission:sql("SELECT has_table_privilege('hive_app_runtime','"+table+"','"+permission+"')")=='t' for permission in ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']}
Path(args.output).write_text(json.dumps(result,sort_keys=True,indent=2)+'\n')
print(json.dumps({"tables":len(tables),"migrations":len(result['migrations']),"outputSha256":hashlib.sha256(Path(args.output).read_bytes()).hexdigest()}))
