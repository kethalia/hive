import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("hive_audio", Path(__file__).with_name("hive-audio.py"))
audio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audio)


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


if __name__ == "__main__":
    unittest.main()
