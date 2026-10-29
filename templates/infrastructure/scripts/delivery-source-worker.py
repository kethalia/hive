#!/usr/bin/env python3
"""Fixed protected-host worker; private inherited FD3 only, no stdin/CLI RPC.

The parent must enforce an overall deadline and kill/reap this worker on EOF or
timeout. Network DNS/system calls are not individually cancellable in Python.
This process and descendants remain inside the native guardian ownership tree.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import socket
import struct
import sys
import time

sys.dont_write_bytecode = True
MAX_FRAME, MAX_TOTAL, MAX_FRAMES = 65536, 8 * 1024 * 1024, 4096


class ProtocolError(Exception):
    pass


class Channel:
    def __init__(self, fd=3):
        self.socket = socket.socket(fileno=fd)
        if self.socket.family != socket.AF_UNIX or self.socket.type != socket.SOCK_STREAM:
            raise ProtocolError()
        pid, uid, _gid = struct.unpack("3i", self.socket.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if pid != os.getppid() or uid != os.getuid():
            raise ProtocolError()
        self.socket.setblocking(False)
        self.buffer = bytearray()
        self.total, self.frames, self.sequence = 0, 0, 0
        self.deadline = time.monotonic() + 120

    def charge(self, size):
        self.total += size
        if self.total > MAX_TOTAL:
            raise ProtocolError()

    def wait(self, writing=False):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise ProtocolError()
        readable, writable, _ = select.select([] if writing else [self.socket], [self.socket] if writing else [], [], remaining)
        if not readable and not writable:
            raise ProtocolError()

    def receive(self):
        while b"\n" not in self.buffer:
            self.wait()
            part = self.socket.recv(min(8192, MAX_FRAME + 1 - len(self.buffer)))
            if not part:
                raise ProtocolError()
            self.charge(len(part))
            self.buffer.extend(part)
            if len(self.buffer) > MAX_FRAME:
                raise ProtocolError()
        raw, _, remainder = self.buffer.partition(b"\n")
        self.buffer = bytearray(remainder)
        self.frames += 1
        if self.frames > MAX_FRAMES:
            raise ProtocolError()
        try:
            def pairs(values):
                result = {}
                for key, value in values:
                    if key in result:
                        raise ProtocolError()
                    result[key] = value
                return result
            value = json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ProtocolError()))
        except (ValueError, RecursionError):
            raise ProtocolError() from None
        if not isinstance(value, dict) or type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1:
            raise ProtocolError()
        return value

    def send(self, kind, value):
        self.sequence += 1
        raw = json.dumps({"schemaVersion": 1, "type": kind, "id": self.sequence, "value": value},
                         separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode() + b"\n"
        if len(raw) > MAX_FRAME:
            raise ProtocolError()
        self.charge(len(raw))
        offset = 0
        while offset < len(raw):
            self.wait(writing=True)
            offset += self.socket.send(raw[offset:])
        return self.sequence

    def exchange(self, kind, value, reply_kind="response"):
        identifier = self.send(kind, value)
        reply = self.receive()
        if set(reply) != {"schemaVersion", "type", "id", "value"} or reply["type"] != reply_kind or type(reply["id"]) is not int or reply["id"] != identifier:
            raise ProtocolError()
        return reply["value"]


def pins(value):
    if not isinstance(value, dict) or set(value) != {"checkout", "git"}:
        raise ProtocolError()
    result = {}
    for key, pair in value.items():
        if not isinstance(pair, dict) or set(pair) != {"device", "inode"}:
            raise ProtocolError()
        result[key] = {}
        for name, raw in pair.items():
            if not isinstance(raw, str) or not re.fullmatch(r"0|[1-9][0-9]{0,19}", raw) or int(raw) > 2**64 - 1:
                raise ProtocolError()
            result[key][name] = int(raw)
    return result


def run(channel):
    start = channel.receive()
    if set(start) != {"schemaVersion", "type", "value"} or start["type"] != "start":
        raise ProtocolError()
    config = start["value"]
    if not isinstance(config, dict) or set(config) != {
        "root", "workspace", "scope", "policy", "metadataIdentity", "attemptLeaseGeneration", "request"}:
        raise ProtocolError()
    spec = importlib.util.spec_from_file_location("hive_fixed_source_runtime", Path(__file__).with_name("delivery-source-runtime.py"))
    runtime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runtime)

    def metadata():
        return pins(channel.exchange("authorize", {"action": "metadata"}))

    broker = runtime.ProtectedSourceBroker(
        config["root"], config["workspace"], config["scope"], policy=config["policy"],
        metadata_identity=pins(config["metadataIdentity"]), metadata_authority=metadata,
        attempt_lease_generation=config["attemptLeaseGeneration"])
    broker.import_parent()
    receipt = broker.prepare(config["request"])
    if receipt["phase"] == "held":
        channel.send("result", {"receipt": receipt, "readback": None})
        return
    material = broker.challenge_material(config["request"]["operationId"])
    grant = channel.exchange("prepared", {"receipt": receipt, "challenge": material}, "grant")
    reauthorize = lambda: channel.exchange("authorize", {"action": "publication"})
    receipt = broker.publish_authorized(config["request"]["operationId"], grant, reauthorize)
    readback = broker.fresh_readback(config["request"]["operationId"], grant, reauthorize) if receipt["phase"] == "published" else None
    channel.send("result", {"receipt": receipt, "readback": readback})


if __name__ == "__main__":
    channel = None
    try:
        if len(sys.argv) != 1:
            raise ProtocolError()
        channel = Channel()
        run(channel)
    except Exception:
        # No raw exception/provider/body/config output, including tracebacks.
        if channel is not None:
            try:
                channel.send("error", {"code": "source_worker_failed"})
            except Exception:
                pass
        sys.exit(1)
    finally:
        if channel is not None:
            channel.socket.close()
