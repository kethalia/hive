#!/usr/bin/env python3
"""Loopback CONNECT route for the existing Rancher ingress, with end-to-end TLS."""

import json
import os
import select
import signal
import socket
import threading
import time


AUTHORITY = "rancher.local.kethalia.com:443"
UPSTREAM = ("ingress-nginx-controller-internal.ingress-nginx.svc.cluster.local", 443)
HEADER_LIMIT = 8192
BUFFER_LIMIT = 65536


def _connect_ingress():
    return socket.create_connection(UPSTREAM, timeout=10)


class _ConnectServer:
    """Internal socket implementation. Tests supply an exclusively loopback connector."""

    def __init__(self, connector):
        self.connector = connector
        self.stopped = threading.Event()
        self.lock = threading.Lock()
        self.sockets = set()
        self.workers = []
        self.slots = threading.BoundedSemaphore(8)
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            self.listener.bind(("127.0.0.1", 0))
            self.listener.listen(8)
            self.listener.settimeout(0.1)
        except BaseException:
            self.listener.close()
            raise
        self.proxy_url = f"http://127.0.0.1:{self.listener.getsockname()[1]}"
        self.thread = threading.Thread(target=self._accept, daemon=True)
        self.thread.start()

    def _track(self, connection):
        with self.lock:
            if self.stopped.is_set():
                connection.close()
                raise OSError("proxy stopped")
            self.sockets.add(connection)

    def _accept(self):
        while not self.stopped.is_set():
            try:
                connection, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            if not self.slots.acquire(blocking=False):
                connection.close()
                continue
            try:
                self._track(connection)
            except OSError:
                self.slots.release()
                return
            worker = threading.Thread(target=self._handle, args=(connection,), daemon=True)
            self.workers = [item for item in self.workers if item.is_alive()]
            self.workers.append(worker)
            worker.start()

    def _header(self, connection):
        deadline = time.monotonic() + 10
        header = bytearray()
        while b"\r\n\r\n" not in header:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or len(header) >= HEADER_LIMIT:
                raise ValueError("invalid CONNECT header")
            connection.settimeout(remaining)
            block = connection.recv(min(1024, HEADER_LIMIT - len(header)))
            if not block:
                raise ValueError("missing CONNECT header")
            header.extend(block)
        head, tail = bytes(header).split(b"\r\n\r\n", 1)
        lines = head.decode("ascii").split("\r\n")
        if lines[0] not in (f"CONNECT {AUTHORITY} HTTP/1.1", f"CONNECT {AUTHORITY} HTTP/1.0"):
            raise ValueError("CONNECT target rejected")
        seen = set()
        for line in lines[1:]:
            name, separator, value = line.partition(":")
            if not separator or not name or name.strip() != name or line[0].isspace():
                raise ValueError("invalid CONNECT header")
            name, value = name.lower(), value.strip()
            if name in seen:
                raise ValueError("duplicate CONNECT header")
            seen.add(name)
            if name == "host" and value != AUTHORITY:
                raise ValueError("CONNECT host rejected")
            if name == "transfer-encoding" or (name == "content-length" and value != "0"):
                raise ValueError("CONNECT body rejected")
        return tail

    def _handle(self, connection):
        upstream = None
        established = False
        try:
            tail = self._header(connection)
            upstream = self.connector()
            self._track(upstream)
            connection.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            established = True
            self._relay(connection, upstream, tail)
        except (OSError, ValueError, UnicodeError):
            if not established:
                try:
                    connection.sendall(b"HTTP/1.1 502 Tunnel Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                except OSError:
                    pass
        finally:
            with self.lock:
                for item in (connection, upstream):
                    if item is not None:
                        self.sockets.discard(item)
                        item.close()
            self.slots.release()

    def _relay(self, client, upstream, tail):
        peers = {client: upstream, upstream: client}
        pending = {client: bytearray(), upstream: bytearray(tail)}
        readable = set(peers)
        shutdown = set()
        for item in peers:
            item.setblocking(False)
        while not self.stopped.is_set():
            for source, target in peers.items():
                if source not in readable and not pending[target] and target not in shutdown:
                    target.shutdown(socket.SHUT_WR)
                    shutdown.add(target)
            if not readable and not any(pending.values()):
                return
            reads = [item for item in readable if len(pending[peers[item]]) < BUFFER_LIMIT]
            writes = [item for item in peers if pending[item]]
            ready_read, ready_write, _ = select.select(reads, writes, [], 0.1)
            for item in ready_read:
                target = peers[item]
                try:
                    block = item.recv(BUFFER_LIMIT - len(pending[target]))
                except BlockingIOError:
                    continue
                if block:
                    pending[target].extend(block)
                else:
                    readable.remove(item)
            for item in ready_write:
                try:
                    sent = item.send(pending[item])
                except BlockingIOError:
                    continue
                if not sent:
                    return
                del pending[item][:sent]

    def close(self):
        self.stopped.set()
        self.listener.close()
        with self.lock:
            for item in self.sockets:
                try:
                    item.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                item.close()
        self.thread.join()
        for worker in self.workers:
            worker.join()


class RancherTunnel:
    """Owned, Infrastructure-only tunnel. No credentials or TLS termination."""

    def __enter__(self):
        if os.environ.get("HIVE_WORKSPACE_PROFILE") != "infrastructure":
            raise RuntimeError("Rancher tunnel requires the Infrastructure workspace")
        self.server = _ConnectServer(_connect_ingress)
        self.proxy_url = self.server.proxy_url
        return self

    def __exit__(self, *_):
        self.server.close()


def main():
    stopped = threading.Event()
    previous = {}
    for signum in (signal.SIGINT, signal.SIGTERM):
        previous[signum] = signal.signal(signum, lambda *_: stopped.set())
    try:
        with RancherTunnel() as tunnel:
            print(json.dumps({"ready": True, "proxyUrl": tunnel.proxy_url}), flush=True)
            stopped.wait()
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    main()
