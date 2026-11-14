/** Private transport to the existing app-server proxy. All RPC enters via framed stdin. */
export const VOICE_PTY_SCRIPT = String.raw`
import base64,collections,fcntl,hashlib,json,os,re,selectors,signal,struct,subprocess,sys,termios,time
N,THREAD,TTL=sys.argv[1:4]
P="HIVE_VOICE_"+N+":"
LIMIT=2*1024*1024
UUID=re.compile(r"^[0-9a-fA-F-]{36}$")
end=time.monotonic()+min(1800,float(TTL))
child=None
lock=None
active=False
start_edge=None
stop_edge=None
pending={}
wire=b""
fragment=b""
fragmented=False
incoming=b""
upload=b""
upload_seq=0
upload_index=0
out_seq=0
out_index=0
out_offset=0
outgoing=collections.deque()
awaiting=False
writes=bytearray()
write_deadline=0
last_control=time.monotonic()
selector=selectors.DefaultSelector()

def emit(kind,value=""):
    sys.stdout.write(P+kind+":"+value+"\n")
    sys.stdout.flush()

def queue_frame(payload,opcode=1):
    global write_deadline
    if len(writes)+len(payload)>LIMIT:
        raise ValueError()
    mask=os.urandom(4)
    length=len(payload)
    header=bytes([128|opcode])
    if length<126: header+=bytes([128|length])
    elif length<65536: header+=bytes([254])+struct.pack("!H",length)
    else: header+=bytes([255])+struct.pack("!Q",length)
    if not writes: write_deadline=time.monotonic()+3
    writes.extend(header+mask+bytes(value^mask[index%4] for index,value in enumerate(payload)))
    return len(writes)

def advanced(count):
    global active,start_edge,stop_edge
    del writes[:count]
    if start_edge is not None:
        start_edge-=count
        if start_edge<=0: active=True; start_edge=None
    if stop_edge is not None:
        stop_edge-=count
        if stop_edge<=0: active=False; stop_edge=None

def admit(value):
    global start_edge,stop_edge
    message=json.loads(value.decode("utf-8"))
    if not isinstance(message,dict) or set(message)-{"id","method","params"}: raise ValueError()
    method=message.get("method")
    params=message.get("params",{})
    ident=message.get("id")
    if method=="initialized":
        if set(message)!={"method"}: raise ValueError()
    else:
        if type(ident) is not int or not 1<=ident<=4096 or ident in pending or len(pending)>=128: raise ValueError()
        if method=="initialize":
            if params!={"clientInfo":{"name":"hive_voice","title":"Hive Voice","version":"0.1.0"},"capabilities":{"experimentalApi":True}}: raise ValueError()
        elif method=="thread/loaded/list":
            if params!={"limit":100}: raise ValueError()
        elif method=="thread/read":
            if set(params)!={"threadId","includeTurns"} or params["includeTurns"] is not False or not UUID.fullmatch(params["threadId"]): raise ValueError()
        elif method=="thread/realtime/start":
            if THREAD=="-" or set(params)!={"threadId","version","outputModality","transport"} or params["threadId"]!=THREAD or params["version"]!="v3" or params["outputModality"]!="audio": raise ValueError()
            transport=params["transport"]
            if set(transport)!={"type","sdp"} or transport["type"]!="webrtc" or not isinstance(transport["sdp"],str) or len(transport["sdp"].encode())>65536 or not transport["sdp"].startswith("v=0") or "m=audio" not in transport["sdp"]: raise ValueError()
            if active or start_edge is not None: raise ValueError()
        elif method=="thread/realtime/stop":
            if THREAD=="-" or params!={"threadId":THREAD}: raise ValueError()
        else: raise ValueError()
        pending[ident]=method
    edge=queue_frame(value)
    if method=="thread/realtime/start": start_edge=edge
    elif method=="thread/realtime/stop": stop_edge=edge

def receive(payload):
    global active
    message=json.loads(payload.decode("utf-8"))
    if not isinstance(message,dict): raise ValueError()
    ident=message.get("id")
    if type(ident) is int and ident in pending and ("result" in message or "error" in message):
        method=pending.pop(ident)
        if method=="thread/realtime/start" and "error" in message: active=False
    elif message.get("method") in ["thread/realtime/sdp","thread/realtime/error","thread/realtime/closed"] and message.get("params",{}).get("threadId")==THREAD:
        if message["method"]=="thread/realtime/closed": active=False
    else: return
    if sum(len(item) for item in outgoing)+len(payload)>LIMIT: raise ValueError()
    outgoing.append(payload)

def parse_frames():
    global wire,fragment,fragmented
    while len(wire)>=2:
        first,second=wire[:2]
        opcode=first&15
        fin=bool(first&128)
        if first&112 or second&128: raise ValueError()
        length=second&127
        at=2
        if length==126:
            if len(wire)<4: return
            length=struct.unpack("!H",wire[2:4])[0]; at=4
        elif length==127:
            if len(wire)<10: return
            length=struct.unpack("!Q",wire[2:10])[0]; at=10
        if length>LIMIT or (opcode>=8 and (not fin or length>125)): raise ValueError()
        if len(wire)<at+length: return
        data=wire[at:at+length]; wire=wire[at+length:]
        if opcode==8: raise EOFError()
        if opcode==9: queue_frame(data,10); continue
        if opcode==10: continue
        if opcode in [1,2]:
            if fragmented: raise ValueError()
            fragment=data; fragmented=not fin
        elif opcode==0:
            if not fragmented: raise ValueError()
            fragment+=data; fragmented=not fin
        else: raise ValueError()
        if len(fragment)>LIMIT: raise ValueError()
        if fin:
            receive(fragment); fragment=b""

def control(line):
    global last_control,upload,upload_seq,upload_index,awaiting,out_seq,out_index,out_offset
    if not line.startswith(P): raise ValueError()
    last_control=time.monotonic()
    rest=line[len(P):]
    if rest=="PING:": return
    if rest=="CANCEL:": raise EOFError()
    if rest.startswith("RECEIVED:"):
        if not awaiting or rest!=f"RECEIVED:{out_seq}:{out_index}": raise ValueError()
        awaiting=False
        out_offset+=min(2048,len(outgoing[0])-out_offset)
        if out_offset==len(outgoing[0]):
            outgoing.popleft(); out_seq+=1; out_index=0; out_offset=0
        else: out_index+=1
        return
    fields=rest.split(":")
    if len(fields)!=5 or fields[0]!="IN" or fields[1]!=str(upload_seq) or fields[2]!=str(upload_index) or fields[3] not in ["0","1"]: raise ValueError()
    data=base64.b64decode(fields[4],validate=True)
    if not data or len(data)>2048 or len(upload)+len(data)>LIMIT: raise ValueError()
    upload+=data
    if fields[3]=="1": admit(upload)
    emit("ACK",f"{upload_seq}:{upload_index}")
    if fields[3]=="1": upload_seq+=1; upload_index=0; upload=b""
    else: upload_index+=1

def stop():
    global wire
    if child is None: return
    stopping=any(method=="thread/realtime/stop" for method in pending.values())
    if (active or stopping) and THREAD!="-" and child.poll() is None:
        try:
            if not stopping:
                pending[0]="thread/realtime/stop"
                queue_frame(json.dumps({"id":0,"method":"thread/realtime/stop","params":{"threadId":THREAD}}).encode())
            until=time.monotonic()+2
            while time.monotonic()<until:
                if writes:
                    try:
                        count=os.write(child.stdin.fileno(),writes)
                        advanced(count)
                    except BlockingIOError: pass
                parse_frames()
                if not writes and not any(method=="thread/realtime/stop" for method in pending.values()): break
                try:
                    data=os.read(child.stdout.fileno(),4096)
                    if not data: break
                    wire+=data
                    if len(wire)>LIMIT+16: break
                except BlockingIOError: time.sleep(0.01)
        except Exception: pass
    if child.poll() is None:
        try: os.killpg(child.pid,signal.SIGTERM)
        except ProcessLookupError: pass
        try: child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            try: os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError: pass
            try: child.wait(timeout=1)
            except subprocess.TimeoutExpired: pass

try:
    if not re.fullmatch(r"[a-f0-9-]{36}",N) or (THREAD!="-" and not UUID.fullmatch(THREAD)) or not 0<float(TTL)<=1800: raise ValueError()
    attrs=termios.tcgetattr(sys.stdin.fileno())
    attrs[0]=0; attrs[1]=0; attrs[3]=0
    termios.tcsetattr(sys.stdin.fileno(),termios.TCSANOW,attrs)
    signal.signal(signal.SIGALRM,lambda *_: (_ for _ in ()).throw(TimeoutError()))
    signal.setitimer(signal.ITIMER_REAL,min(1800,float(TTL))+3)
    emit("READY")
    selector.register(sys.stdin,selectors.EVENT_READ)
    if not selector.select(5) or sys.stdin.readline().rstrip("\n")!=P+"GO:": raise ValueError()
    if THREAD!="-":
        home=os.environ.get("CODEX_HOME",os.path.expanduser("~/.codex"))
        directory=os.path.join(home,"hive-voice")
        os.umask(0o077); os.makedirs(directory,exist_ok=True)
        lock=os.open(os.path.join(directory,THREAD+".lock"),os.O_CREAT|os.O_WRONLY|os.O_NOFOLLOW,0o600)
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    child=subprocess.Popen(["bash","-lc","exec codex app-server proxy"],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
    key=base64.b64encode(os.urandom(16)).decode()
    child.stdin.write(("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: "+key+"\r\nSec-WebSocket-Version: 13\r\n\r\n").encode()); child.stdin.flush()
    os.set_blocking(child.stdout.fileno(),False)
    selector.register(child.stdout,selectors.EVENT_READ)
    os.set_blocking(sys.stdin.fileno(),False)
    header=b""; until=min(end,time.monotonic()+10)
    while b"\r\n\r\n" not in header:
        if time.monotonic()>=until: raise TimeoutError()
        selected=selector.select(0.1)
        if not selected: continue
        if selected[0][0].fileobj is sys.stdin:
            data=os.read(sys.stdin.fileno(),4096)
            if not data: raise EOFError()
            incoming+=data
            while b"\n" in incoming:
                line,incoming=incoming.split(b"\n",1)
                if line.decode("ascii")!=P+"PING:": raise EOFError()
            if len(incoming)>4096: raise ValueError()
            continue
        data=os.read(child.stdout.fileno(),4096)
        if not data: raise EOFError()
        header+=data
        if len(header)>8192: raise ValueError()
    header,wire=header.split(b"\r\n\r\n",1)
    lines=header.decode("ascii").split("\r\n")
    if lines[0].split(" ",2)[:2]!=["HTTP/1.1","101"]: raise ValueError()
    headers={}
    for line in lines[1:]:
        field,value=line.split(":",1); field=field.lower()
        if field in headers: raise ValueError()
        headers[field]=value.strip()
    expected=base64.b64encode(hashlib.sha1((key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
    if headers.get("sec-websocket-accept")!=expected or headers.get("upgrade","").lower()!="websocket" or "upgrade" not in [value.strip().lower() for value in headers.get("connection","").split(",")] or "sec-websocket-extensions" in headers: raise ValueError()
    os.set_blocking(sys.stdin.fileno(),False)
    os.set_blocking(child.stdin.fileno(),False)
    last_control=time.monotonic()
    emit("OPEN")
    while time.monotonic()<end:
        now=time.monotonic()
        if now-last_control>15 or (writes and now>write_deadline): raise TimeoutError()
        parse_frames()
        if outgoing and not awaiting:
            part=outgoing[0][out_offset:out_offset+2048]
            emit("OUT",f"{out_seq}:{out_index}:{int(out_offset+len(part)==len(outgoing[0]))}:"+base64.b64encode(part).decode())
            awaiting=True
        if writes:
            try:
                count=os.write(child.stdin.fileno(),writes)
                advanced(count)
                if not writes: write_deadline=0
            except BlockingIOError: pass
        for selected,_ in selector.select(0.01):
            if selected.fileobj is sys.stdin:
                data=os.read(sys.stdin.fileno(),8192)
                if not data: raise EOFError()
                incoming+=data
                while b"\n" in incoming:
                    line,incoming=incoming.split(b"\n",1)
                    control(line.decode("ascii"))
                if len(incoming)>4096: raise ValueError()
            else:
                data=os.read(child.stdout.fileno(),4096)
                if not data: raise EOFError()
                wire+=data
                if len(wire)>LIMIT+16: raise ValueError()
except Exception:
    pass
finally:
    signal.setitimer(signal.ITIMER_REAL,0)
    stop()
    selector.close()
    if child is not None:
        child.stdin.close(); child.stdout.close()
    if lock is not None: os.close(lock)
    emit("CLOSED")
`;
