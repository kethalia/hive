import base64,json,os,pty,selectors,signal,sys
script=base64.b64decode(sys.argv[1]).decode()
pid,master=pty.fork()
if pid==0:
    os.execv(sys.executable,[sys.executable,"-u","-c",script,*sys.argv[2:]])
selector=selectors.DefaultSelector()
selector.register(sys.stdin,selectors.EVENT_READ)
selector.register(master,selectors.EVENT_READ)
pending=b""
try:
    while True:
        for selected,_ in selector.select():
            if selected.fileobj is sys.stdin:
                data=os.read(sys.stdin.fileno(),65536)
                if not data:
                    selector.unregister(sys.stdin)
                    continue
                pending+=data
                while b"\n" in pending:
                    line,pending=pending.split(b"\n",1)
                    data=base64.b64decode(line,validate=True)
                    at=0
                    while at<len(data): at+=os.write(master,data[at:])
            else:
                try: data=os.read(master,65536)
                except OSError: data=b""
                if not data: raise EOFError()
                print(base64.b64encode(data).decode(),flush=True)
except EOFError:
    pass
finally:
    selector.close()
    os.close(master)
    os.waitpid(pid,0)
