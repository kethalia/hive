import pathlib,os,subprocess,json,importlib.util,time,hashlib
root=pathlib.Path('/home/coder/projects/kethalia/.private-hive-rehearsal-20261105')
spec=importlib.util.spec_from_file_location('capture','scripts/checks/data-migration/capture.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
url=c.connection(root/'local-url');env=c.environment(url)
assert env['PGHOST']=='127.0.0.1' and env['PGPORT']=='55491' and env['PGDATABASE']=='hive_production_rehearsal_20261105'
start=time.monotonic();target='hive_recovery_rehearsal_20261105'
clean={k:v for k,v in os.environ.items() if not k.startswith('PG')}
for label,conn in ([] if (root/'upgraded-backup/capture.json').is_file() else [('upgraded-backup',root/'local-url')]):
 p=subprocess.run(['python3','-B','scripts/checks/data-migration/capture.py','--connection-file',str(conn),'--destination',str(root/label),'--max-source-bytes','104857600','--max-rows','100000','--timeout-seconds','120'],env=clean,capture_output=True,text=True,timeout=130)
 assert p.returncode==0,'backup_capture_failed'
admin={**env,'PGDATABASE':'postgres','PGUSER':'coder','PGOPTIONS':'-c statement_timeout=120000 -c lock_timeout=10000'}
p=subprocess.run(['psql','-X','-v','ON_ERROR_STOP=1','-c','CREATE DATABASE '+target+' OWNER coder TEMPLATE template0;'],env=admin,capture_output=True,timeout=20);assert p.returncode==0,'recovery_target_creation_failed'
env2={**env,'PGDATABASE':target,'PGUSER':'coder','PGOPTIONS':'-c statement_timeout=120000 -c lock_timeout=10000'}
p=subprocess.run(['psql','-X','-v','ON_ERROR_STOP=1','-c','DROP SCHEMA public;'],env=env2,capture_output=True,timeout=20);assert p.returncode==0,'empty_target_schema_failed'
p=subprocess.run(['pg_restore','--dbname='+target,'--no-owner','--no-privileges','--single-transaction',str(root/'upgraded-backup/source.dump')],env=env2,capture_output=True,timeout=90);assert p.returncode==0,'recovery_restore_failed'
from urllib.parse import urlsplit,urlunsplit
u=urlsplit(url);newurl=urlunsplit(u._replace(path='/'+target,netloc='coder@127.0.0.1:55491'));fd=os.open(root/'recovery-url',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:f.write(newurl)
p=subprocess.run(['python3','-B','scripts/checks/data-migration/capture.py','--connection-file',str(root/'recovery-url'),'--destination',str(root/'recovered-backup'),'--max-source-bytes','104857600','--max-rows','100000','--timeout-seconds','120'],env=clean,capture_output=True,text=True,timeout=130);assert p.returncode==0,'recovery_verification_capture_failed'
a=json.loads((root/'upgraded-backup/capture.json').read_text());b=json.loads((root/'recovered-backup/capture.json').read_text())
assert a['tables']==b['tables'],'recovery_rows_changed'
result={'schemaVersion':1,'source':'isolated local upgraded production capture','target':target,'originalCaptureSha256':json.loads((root/'capture.json').read_text())['archiveSha256'],'backupSha256':a['archiveSha256'],'backupBytes':a['archiveBytes'],'tables':len(a['tables']),'rows':sum(v['count'] for v in a['tables'].values()),'allTableRowsAndColumnsMatch':True,'elapsedSeconds':round(time.monotonic()-start,2),'productionMutations':0,'neonBackupRestoreTested':False,'postCutoverWriteRecoveryTested':False,'limits':['Local PostgreSQL17 backup/restore rehearsal only; this does not prove Neon service restore or application behavior.','Target is an isolated local database. Raw backup remains owner-only outside repository.']}
pathlib.Path('docs/checks/autonomous-delivery/production-data-capture/20261105-recovery.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
