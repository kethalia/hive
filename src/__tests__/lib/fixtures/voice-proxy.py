import base64,hashlib,json,os,struct,sys

def record(data):
    with open(os.environ["VOICE_FAKE_RECORD"],"a") as file:
        file.write(json.dumps(data)+"\n")
        file.flush()

def read(count):
    data=sys.stdin.buffer.read(count)
    if len(data)!=count: raise EOFError()
    return data

def frame(payload,opcode=1,fin=True):
    size=len(payload)
    header=bytes([(128 if fin else 0)|opcode])
    if size<126: header+=bytes([size])
    elif size<65536: header+=bytes([126])+struct.pack("!H",size)
    else: header+=bytes([127])+struct.pack("!Q",size)
    sys.stdout.buffer.write(header+payload)
    sys.stdout.buffer.flush()

def send(value):
    data=json.dumps(value).encode()
    if len(data)>20:
        frame(data[:11],1,False)
        frame(data[11:],0,True)
    else: frame(data)

record({"pid":os.getpid()})
try:
    headers=b""
    while not headers.endswith(b"\r\n\r\n"):
        headers+=read(1)
        if len(headers)>8192: raise ValueError()
    values={}
    for line in headers.decode().split("\r\n")[1:]:
        if ":" in line:
            name,value=line.split(":",1); values[name.lower()]=value.strip()
    accept=base64.b64encode(hashlib.sha1((values["sec-websocket-key"]+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
    if os.environ.get("VOICE_FAKE_BAD_HANDSHAKE")=="1": accept="wrong"
    handshake=("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+accept+"\r\n\r\n").encode()
    sys.stdout.buffer.write(handshake[:17]); sys.stdout.buffer.flush()
    sys.stdout.buffer.write(handshake[17:]); sys.stdout.buffer.flush()
    while True:
        first,second=read(2)
        if not first&128 or not second&128: raise ValueError()
        size=second&127
        if size==126: size=struct.unpack("!H",read(2))[0]
        elif size==127: size=struct.unpack("!Q",read(8))[0]
        if size>2*1024*1024: raise ValueError()
        mask=read(4)
        data=read(size)
        payload=bytes(value^mask[index%4] for index,value in enumerate(data))
        if first&15==10: continue
        if first&15!=1: raise ValueError()
        message=json.loads(payload.decode())
        method=message["method"]
        record({"method":method,"id":message.get("id")})
        ident=message.get("id")
        if ident is None: continue
        if method=="initialize":
            frame(b"ping",9)
            result={}
        elif method=="thread/loaded/list": result={"data":[os.environ["VOICE_FAKE_THREAD"]]}
        elif method=="thread/read": result={"thread":{"id":message["params"]["threadId"],"name":"active-"+"x"*9000,"cwd":"/fixture"}}
        elif method=="thread/realtime/start":
            if os.environ.get("VOICE_FAKE_REJECT")=="1":
                send({"id":ident,"error":{"message":"private-provider-error"}})
                continue
            result={}
        elif method=="thread/realtime/stop": result={}
        else: raise ValueError()
        send({"id":ident,"result":result})
        if method=="thread/realtime/start":
            send({"method":"thread/realtime/sdp","params":{"threadId":message["params"]["threadId"],"sdp":"v=0\r\nm=audio"}})
        if method=="thread/realtime/stop":
            send({"method":"thread/realtime/closed","params":{"threadId":message["params"]["threadId"]}})
except EOFError:
    pass
