import importlib.util
import os
from pathlib import Path
import socket
import threading
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("rancher_tunnel", Path(__file__).with_name("rancher_tunnel.py"))
tunnel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tunnel)


def receive_headers(connection):
    data = bytearray()
    while b"\r\n\r\n" not in data:
        block = connection.recv(1024)
        if not block:
            break
        data.extend(block)
    return bytes(data)


class RancherTunnelTests(unittest.TestCase):
    def test_live_entrypoint_requires_infrastructure_before_binding(self):
        with patch.dict(os.environ, {"HIVE_WORKSPACE_PROFILE": "software"}):
            with patch.object(tunnel.socket, "socket") as create_socket:
                with self.assertRaisesRegex(RuntimeError, "Infrastructure"):
                    with tunnel.RancherTunnel():
                        self.fail("must reject software profile")
                create_socket.assert_not_called()

    def test_production_connector_has_one_fixed_destination(self):
        with patch.object(tunnel.socket, "create_connection") as connect:
            tunnel._connect_ingress()
            connect.assert_called_once_with(
                ("ingress-nginx-controller-internal.ingress-nginx.svc.cluster.local", 443), timeout=10
            )

    def start_proxy(self, connector):
        server = tunnel._ConnectServer(connector)
        self.addCleanup(server.close)
        self.assertEqual(server.listener.getsockname()[0], "127.0.0.1")
        connection = socket.create_connection(server.listener.getsockname(), timeout=3)
        self.addCleanup(connection.close)
        return server, connection

    def test_rejected_authorities_methods_and_headers_never_dial(self):
        requests = [
            b"CONNECT other.example:443 HTTP/1.1\r\n\r\n",
            b"CONNECT rancher.local.kethalia.com:80 HTTP/1.1\r\n\r\n",
            b"CONNECT rancher.local.kethalia.com:443@other.example:443 HTTP/1.1\r\n\r\n",
            b"GET https://rancher.local.kethalia.com/ HTTP/1.1\r\n\r\n",
            f"CONNECT {tunnel.AUTHORITY} HTTP/1.1\r\nHost: other.example\r\n\r\n".encode(),
            f"CONNECT {tunnel.AUTHORITY} HTTP/1.1\r\nContent-Length: 2\r\n\r\n".encode(),
            f"CONNECT {tunnel.AUTHORITY} HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n".encode(),
            f"CONNECT {tunnel.AUTHORITY} HTTP/1.1\r\nHost: {tunnel.AUTHORITY}\r\nHost: {tunnel.AUTHORITY}\r\n\r\n".encode(),
            b"X" * tunnel.HEADER_LIMIT,
        ]
        for request in requests:
            with self.subTest(request=request[:100]):
                with patch.object(tunnel, "_connect_ingress") as connect:
                    server, connection = self.start_proxy(connect)
                    connection.sendall(request)
                    self.assertIn(b"502", receive_headers(connection))
                    connect.assert_not_called()
                    server.close()

    def test_opaque_bytes_backpressure_and_half_close(self):
        local, remote = socket.socketpair()
        self.addCleanup(remote.close)
        request_bytes = bytes(range(256)) * 1500
        response_bytes = request_bytes[::-1]
        received = bytearray()
        errors = []

        def upstream():
            try:
                remote.settimeout(3)
                while True:
                    block = remote.recv(8192)
                    if not block:
                        break
                    received.extend(block)
                remote.sendall(response_bytes)
                remote.shutdown(socket.SHUT_WR)
            except BaseException as error:
                errors.append(error)

        worker = threading.Thread(target=upstream)
        worker.start()
        server, connection = self.start_proxy(lambda: local)
        connection.sendall(f"CONNECT {tunnel.AUTHORITY} HTTP/1.1\r\nHost: {tunnel.AUTHORITY}\r\n\r\n".encode())
        self.assertEqual(receive_headers(connection), b"HTTP/1.1 200 Connection Established\r\n\r\n")
        connection.sendall(request_bytes)
        connection.shutdown(socket.SHUT_WR)
        response = bytearray()
        while True:
            block = connection.recv(8192)
            if not block:
                break
            response.extend(block)
        worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(received, request_bytes)
        self.assertEqual(response, response_bytes)
        server.close()
        self.assertFalse(server.thread.is_alive())
        self.assertTrue(all(not item.is_alive() for item in server.workers))

    def test_close_drains_owned_active_sockets_and_listener(self):
        local, remote = socket.socketpair()
        self.addCleanup(remote.close)
        server, connection = self.start_proxy(lambda: local)
        address = server.listener.getsockname()
        connection.sendall(f"CONNECT {tunnel.AUTHORITY} HTTP/1.1\r\n\r\n".encode())
        self.assertIn(b"200", receive_headers(connection))
        server.close()
        self.assertEqual(connection.recv(1), b"")
        self.assertEqual(remote.recv(1), b"")
        self.assertFalse(server.thread.is_alive())
        self.assertTrue(all(not item.is_alive() for item in server.workers))
        with self.assertRaises(OSError):
            socket.create_connection(address, timeout=0.2)


if __name__ == "__main__":
    unittest.main()
