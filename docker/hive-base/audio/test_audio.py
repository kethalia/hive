import importlib.util
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("hive_audio", Path(__file__).with_name("hive-audio.py"))
audio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audio)

RELAY_BOOTSTRAP = """
import runpy, sys
scope = runpy.run_path(sys.argv[1])
# Exercise the production relay without launching PulseAudio in this test.
scope['relay'].__globals__['prepare'] = lambda session: None
scope['relay'](sys.argv[2])
"""


class Socket:
    def __init__(self):
        self.sent = []

    def sendto(self, data, address):
        self.sent.append((data, address))


class AudioBrokerTest(unittest.TestCase):
    def setUp(self):
        self.socket = Socket()
        self.broker = audio.Broker(self.socket)

    def test_standby_does_not_claim_devices_and_second_view_cannot_take_over(self):
        self.broker.handle(b"B", "browser", 0)
        self.assertEqual(self.socket.sent, [(b"R", "browser"), (b"Z", "browser")])
        self.broker.handle(b"B", "other", 1)
        self.assertEqual(self.socket.sent[-1], (b"N", "other"))
        self.assertEqual(self.broker.owner, "browser")

    def test_pcm_is_routed_only_from_the_owner_while_capture_is_active(self):
        samples = []
        self.broker.microphone = samples.append
        self.broker.handle(b"B", "browser", 0)
        self.broker.handle(b"M\x01\x02", "browser", 0)
        self.assertEqual(samples, [])
        self.broker.capturing = True
        self.broker.handle(b"M\x01\x02", "stranger", 0)
        self.assertEqual(samples, [])
        self.broker.handle(b"M\x01\x02", "browser", 0)
        self.assertEqual(samples, [b"\x01\x02"])

    def test_permission_failure_or_browser_disconnection_ends_native_capture(self):
        stopped = []
        self.broker.stop_devices = lambda: stopped.append(True)
        self.broker.handle(b"B", "browser", 0)
        self.broker.capturing = True
        self.broker.handle(b"Q", "stranger", 1)
        self.assertEqual(stopped, [])
        self.broker.handle(b"Q", "browser", 1)
        self.assertIsNone(self.broker.owner)
        self.assertFalse(self.broker.capturing)
        self.assertEqual(stopped, [True])

    def test_browser_expiry_stops_native_devices(self):
        stopped = []
        self.broker.stop_devices = lambda: stopped.append(True)
        self.broker.handle(b"B", "browser", 0)
        self.broker.capturing = True
        self.broker.expire(14)
        self.assertEqual(stopped, [])
        self.broker.expire(16)
        self.assertIsNone(self.broker.owner)
        self.assertEqual(stopped, [True])

    def test_rejects_odd_and_oversized_samples(self):
        samples = []
        self.broker.microphone = samples.append
        self.broker.handle(b"B", "browser", 0)
        self.broker.capturing = True
        self.broker.handle(b"M\x01", "browser", 1)
        self.broker.handle(b"M" + bytes(962), "browser", 1)
        self.assertEqual(samples, [])

    def test_native_start_waits_for_browser_startup_but_orphaned_capture_expires(self):
        devices = object.__new__(audio.PulseDevices)
        devices.unclaimed_at = None
        devices.microphone_buffer = bytearray()
        devices.speaker_buffer = bytearray()
        devices.list = lambda kind: [{"index": 5, "source": 0}] if kind == "source-outputs" else []
        devices.stop_native = Mock()
        with patch.object(audio.time, "monotonic", return_value=100):
            devices.refresh(self.broker)
        self.assertTrue(self.broker.capturing)
        devices.stop_native.assert_not_called()
        with patch.object(audio.time, "monotonic", return_value=111):
            devices.refresh(self.broker)
        devices.stop_native.assert_called_once()
        self.assertFalse(self.broker.capturing)


class AudioRelayTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="hive-audio-")
        self.addCleanup(directory.cleanup)
        environment = patch.dict(os.environ, HIVE_AUDIO_ROOT=directory.name)
        environment.start()
        self.addCleanup(environment.stop)

    def broker(self, session):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        self.addCleanup(sock.close)
        sock.bind(str(audio.state_directory(session) / "bridge.sock"))
        sock.settimeout(3)
        return sock, audio.Broker(sock)

    def start_relay(self, session):
        process = subprocess.Popen(
            [sys.executable, "-c", RELAY_BOOTSTRAP, str(Path(audio.__file__).resolve()), session],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        def cleanup():
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            for pipe in (process.stdin, process.stdout, process.stderr):
                pipe.close()
        self.addCleanup(cleanup)
        return process

    def receive(self, sock, broker):
        data, address = sock.recvfrom(audio.PACKET + 1)
        broker.handle(data, address, time.monotonic())
        return address

    def read(self, process):
        self.assertTrue(select.select([process.stdout], [], [], 3)[0], "Relay did not respond")
        return json.loads(process.stdout.readline())

    def test_parallel_relays_have_unique_addresses_and_reach_session_ownership(self):
        shared_socket, shared_broker = self.broker("-voice")
        other_socket, other_broker = self.broker("other")
        first = self.start_relay("-voice")
        first_address = self.receive(shared_socket, shared_broker)
        self.assertEqual(self.read(first), {"type": "ready"})
        self.assertEqual(self.read(first), {"type": "active", "active": False})

        other = self.start_relay("other")
        other_address = self.receive(other_socket, other_broker)
        self.assertNotEqual(first_address, other_address)
        self.assertEqual(self.read(other), {"type": "ready"})

        duplicate = self.start_relay("-voice")
        duplicate_address = self.receive(shared_socket, shared_broker)
        self.assertNotEqual(first_address, duplicate_address)
        self.assertEqual(self.read(duplicate)["code"], "session_busy")
        self.assertEqual(duplicate.wait(timeout=3), 0)

        first.stdin.write(b'{"type":"release"}\n')
        self.assertEqual(first.wait(timeout=3), 0)
        while shared_broker.owner is not None:
            self.receive(shared_socket, shared_broker)
        replacement = self.start_relay("-voice")
        self.receive(shared_socket, shared_broker)
        self.assertEqual(self.read(replacement), {"type": "ready"})

    def test_all_commands_parse_leading_dash_session_names(self):
        for command in ("prepare", "serve", "relay"):
            with self.subTest(command=command), patch.object(sys, "argv", ["hive-audio", command, "--", "-voice"]), \
                    patch.object(audio, command, return_value="unix:test") as handler, patch("builtins.print"):
                audio.main()
                handler.assert_called_once_with("-voice")

    def test_prepare_passes_option_terminator_to_spawned_server(self):
        directory = audio.state_directory("-voice")
        with patch.object(audio.shutil, "which", return_value="tool"), \
                patch.object(audio.subprocess, "Popen", side_effect=lambda *args, **kwargs: (directory / "bridge.sock").touch()) as spawn:
            audio.prepare("-voice")
        self.assertEqual(spawn.call_args.args[0][-3:], ["serve", "--", "-voice"])


if __name__ == "__main__":
    unittest.main()
