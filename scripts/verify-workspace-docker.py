#!/usr/bin/env python3
"""Live acceptance for a disposable, Docker-enabled Coder workspace (no credentials)."""
import argparse
import json
import os
from pathlib import Path
import subprocess

IMAGE = 'node:22-alpine@sha256:025b8e975a61d94e33abeafaad1255ef44e4898cf1a1b6446860009c72e6d284'


def run(*command, cwd=None, timeout=300):
    result = subprocess.run(command, cwd=cwd, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError(f'{command[0]} failed ({result.returncode}): {result.stdout[-8000:]}')
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=['produce', 'recover', 'isolate'])
    parser.add_argument('--revision', required=True)
    args = parser.parse_args()
    if not args.revision.isalnum() or len(args.revision) > 20:
        parser.error('revision must be 1–20 alphanumeric characters')
    assert os.getuid() == 1000, 'Run as the workspace owner'
    assert os.environ.get('DOCKER_HOST') == 'unix:///run/hive-docker/docker.sock'
    assert Path('/proc/self/attr/current').read_text().strip() == 'hive-codex-v1 (enforce)'
    fields = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
    assert fields['NoNewPrivs'].strip() == '1'
    assert all(fields[key].strip() == '0000000000000000' for key in ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])
    server = run('docker', 'info', '--format', '{{.ServerVersion}}')
    root = Path.home() / '.cache/hive/docker-acceptance' / args.revision
    tag = 'hive-acceptance:' + args.revision
    volume = 'hive-acceptance-' + args.revision
    if args.stage == 'produce':
        assert not root.exists(), 'Choose a fresh revision'
        root.mkdir(parents=True)
        (root / 'owned').mkdir()
        (root / 'Dockerfile').write_text('ARG BASE\nFROM ${BASE}\nRUN echo build-passed > /built\n'
            'CMD ["node", "-e", "require(\'http\').createServer((q,r)=>r.end(\'service-passed\')).listen(8080,\'0.0.0.0\')"]\n')
        run('docker','build','--network=none','--build-arg','BASE='+IMAGE,'-t',tag,str(root))
        assert run('docker','run','--rm','--entrypoint','cat',tag,'/built') == 'build-passed'
        run('docker','run','--rm','--user','1000:1000','--mount',f'type=bind,source={root}/owned,target=/owned',
            '--entrypoint','sh',tag,'-c','echo owner-passed > /owned/result')
        assert (root/'owned/result').stat().st_uid == 1000
        run('docker','volume','create',volume)
        run('docker','run','--rm','--mount',f'type=volume,source={volume},target=/data','--entrypoint','sh',tag,'-c','echo volume-passed > /data/result')
        repo=root/'repository';repo.mkdir()
        run('git','init','-q',cwd=repo)
        run('git','-c','user.name=Acceptance','-c','user.email=acceptance@invalid','commit','--allow-empty','-qm','fixture',cwd=repo)
        workflow=root/'actions.yaml'
        workflow.write_text(f'''name: Workspace engine acceptance
on: push
defaults:
  run:
    shell: sh
jobs:
  shell:
    runs-on: local-shell
    steps:
      - run: echo shell-passed > {root}/act-result
  container-and-service:
    needs: shell
    runs-on: local-container
    container: {tag}
    services:
      web:
        image: {tag}
        options: >-
          --health-cmd "node -e 'fetch(\\"http://127.0.0.1:8080\\").then(r=>{{if(!r.ok)process.exit(1)}})'"
          --health-interval 2s --health-timeout 5s --health-retries 20
    steps:
      - run: node -e 'fetch("http://web:8080").then(r=>r.text()).then(t=>{{if(t!=="service-passed")process.exit(1)}})'
''')
        run('act','push','-W',str(workflow),'-P','local-shell=-self-hosted','-P','local-container='+tag,
            '--pull=false','--action-offline-mode','--container-daemon-socket','/run/hive-docker/docker.sock',cwd=repo)
        assert (root/'act-result').read_text().strip() == 'shell-passed'
        (root/'complete').write_text(args.revision)
    elif args.stage == 'recover':
        assert (root/'complete').read_text() == args.revision
        assert (root/'owned/result').stat().st_uid == 1000
        assert (root/'owned/result').read_text().strip() == 'owner-passed'
        run('docker','image','inspect',tag)
        assert run('docker','run','--rm','--mount',f'type=volume,source={volume},target=/data',
                   '--entrypoint','cat',tag,'/data/result') == 'volume-passed'
    else:
        assert not root.exists(), 'Another workspace home is visible'
        for resource,name in [('image',tag),('volume',volume)]:
            assert subprocess.run(['docker',resource,'inspect',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode != 0
        # A denied lookup alone is inconclusive: prove this engine can pull/run.
        run('docker','pull',IMAGE)
        assert run('docker','run','--rm','--entrypoint','echo',IMAGE,'own-engine-passed') == 'own-engine-passed'
    print(json.dumps({'stage':args.stage,'revision':args.revision,'server':server,'passed':True}))


if __name__ == '__main__':
    main()
