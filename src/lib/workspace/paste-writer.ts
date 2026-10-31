/** Fixed PTY protocol, not a caller-provided command. Input is base64 data only.
 * The remote alarm owns eventual partial-file cleanup after lost transport. */
export const TERMINAL_PASTE_WRITER = String.raw`
import base64,fcntl,hashlib,json,os,signal,stat,sys,tty
ROOT='/tmp/hive-terminal-paste'
nonce=sys.argv[1]
def check(value):
 if not value: raise ValueError('rejected')
def send(value):
 sys.stdout.write(json.dumps(dict(nonce=nonce,**value),separators=(',',':'))+'\n');sys.stdout.flush()
def frame():
 raw=sys.stdin.buffer.readline(32769)
 check(0<len(raw)<=32768 and raw.endswith(b'\n'))
 return json.loads(raw)
def timeout(*args): raise TimeoutError('expired')
signal.signal(signal.SIGALRM,timeout)
signal.alarm(110)
check(len(nonce)==32 and all(c in '0123456789abcdef' for c in nonce) and os.isatty(0))
tty.setraw(0)
directory=None;partial=None;fd=None
try:
 try: os.mkdir(ROOT,0o700)
 except FileExistsError: pass
 directory=os.open(ROOT,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 info=os.fstat(directory)
 check(info.st_uid==os.getuid() and stat.S_IMODE(info.st_mode)==0o700)
 fcntl.flock(directory,fcntl.LOCK_EX|fcntl.LOCK_NB)
 send({'type':'ready'})
 manifest=frame()
 check(set(manifest)=={'files'} and isinstance(manifest['files'],list) and 1<=len(manifest['files'])<=10)
 total=0;names=set()
 for item in manifest['files']:
  check(set(item)=={'name','size','sha256'})
  name=item['name'];size=item['size'];digest=item['sha256']
  check(isinstance(name,str) and 1<=len(name)<=150 and name not in ('.','..') and all(c in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-' for c in name) and name not in names)
  check(type(size)==int and 0<=size<=10485760 and isinstance(digest,str) and len(digest)==64 and all(c in '0123456789abcdef' for c in digest))
  names.add(name);total+=size
 check(total<=20971520)
 send({'type':'manifest'})
 for index,item in enumerate(manifest['files']):
  start=frame();check(start=={'type':'file','index':index})
  candidate=item['name']+'.part'
  fd=os.open(candidate,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=directory)
  partial=candidate
  written=0;sequence=0;hasher=hashlib.sha256()
  while written<item['size']:
   value=frame()
   check(set(value)=={'sequence','data'} and type(value['sequence'])==int and value['sequence']==sequence and isinstance(value['data'],str))
   data=base64.b64decode(value['data'],validate=True)
   check(0<len(data)<=16384 and written+len(data)<=item['size'])
   view=memoryview(data)
   while view:
    count=os.write(fd,view);check(count>0);view=view[count:]
   written+=len(data);hasher.update(data)
   send({'type':'chunk','index':index,'sequence':sequence})
   sequence+=1
  check(hasher.hexdigest()==item['sha256'])
  os.fsync(fd);file_info=os.fstat(fd);os.close(fd);fd=None
  current=os.stat(ROOT,follow_symlinks=False)
  check(stat.S_ISDIR(current.st_mode) and (current.st_dev,current.st_ino)==(info.st_dev,info.st_ino))
  os.link(partial,item['name'],src_dir_fd=directory,dst_dir_fd=directory,follow_symlinks=False)
  published=os.stat(item['name'],dir_fd=directory,follow_symlinks=False)
  check(stat.S_ISREG(published.st_mode) and (published.st_dev,published.st_ino)==(file_info.st_dev,file_info.st_ino))
  os.unlink(partial,dir_fd=directory);partial=None;os.fsync(directory)
  send({'type':'file','index':index,'size':written,'sha256':item['sha256'],'path':ROOT+'/'+item['name']})
 send({'type':'complete'})
except BaseException:
 try: send({'type':'error'})
 except BaseException: pass
 sys.exit(1)
finally:
 if fd is not None: os.close(fd)
 if partial is not None and directory is not None:
  try: os.unlink(partial,dir_fd=directory);os.fsync(directory)
  except OSError: pass
 if directory is not None: os.close(directory)
`;

export function terminalPasteWriterCommand(nonce: string) {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error("paste_scope");
  const encoded = Buffer.from(TERMINAL_PASTE_WRITER).toString("base64");
  return `exec /usr/bin/python3 -I -c 'import base64;exec(base64.b64decode("${encoded}"))' ${nonce}`;
}
