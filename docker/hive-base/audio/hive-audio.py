#!/usr/bin/env python3
"""Private, per-terminal PCM broker and bounded Coder PTY relay."""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import time
import tty

PACKET = 960
OWNER_TIMEOUT = 15


def state_directory(session):
    if not re.fullmatch(r"[a-zA-Z0-9._-]{1,128}", session):
        raise ValueError("Invalid terminal session")
    root = Path(os.environ.get("HIVE_AUDIO_ROOT", str(Path.home() / ".local/state/hive/audio")))
    directory = root / hashlib.sha256(session.encode()).hexdigest()[:24]
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink() or directory.stat().st_uid != os.getuid():
        raise ValueError("Invalid audio directory")
    directory.chmod(0o700)
    return directory


def prepare(session):
    directory = state_directory(session)
    if not all(shutil.which(command) for command in ("pulseaudio", "pacat", "pactl")):
        raise ValueError("Hive audio device is unavailable")
    # Serialize terminal and relay startup; only serve owns the lifetime lock.
    with (directory / "prepare.lock").open("w") as startup_lock:
        fcntl.flock(startup_lock, fcntl.LOCK_EX)
        with (directory / "broker.lock").open("w") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                start_broker = True
            except BlockingIOError:
                start_broker = False
        if start_broker:
            (directory / "bridge.sock").unlink(missing_ok=True)
            subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "serve", "--", session],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
        deadline = time.monotonic() + 6
        while not (directory / "bridge.sock").exists():
            if time.monotonic() > deadline:
                raise ValueError("Hive audio device did not start")
            time.sleep(0.02)
        return "unix:" + str(directory / "pulse.sock")


class Broker:
    def __init__(self, sock, microphone=None, stop_devices=None):
        self.sock = sock
        self.owner = None
        self.owner_at = 0
        self.capturing = False
        self.microphone = microphone
        self.stop_devices = stop_devices

    def send(self, data, address):
        if address is None:
            return
        try:
            self.sock.sendto(data, address)
        except (OSError, BlockingIOError):
            pass  # Stalled consumers lose samples; queues never grow.

    def active(self):
        self.send(b"A" if self.capturing else b"Z", self.owner)

    def release(self):
        self.capturing = False
        self.owner = None
        if self.stop_devices:
            self.stop_devices()

    def handle(self, data, address, now):
        if data == b"B":
            if self.owner is not None and self.owner != address:
                self.send(b"N", address)
                return
            self.owner, self.owner_at = address, now
            self.send(b"R", address)
            self.active()
        elif data == b"K" and address == self.owner:
            self.owner_at = now
        elif data == b"Q" and address == self.owner:
            self.release()
        elif data[:1] == b"M" and address == self.owner and self.capturing:
            if 1 < len(data) <= PACKET + 1 and (len(data) - 1) % 2 == 0 and self.microphone:
                self.microphone(data[1:])

    def expire(self, now):
        if self.owner and now - self.owner_at > OWNER_TIMEOUT:
            self.release()


class PulseDevices:
    """PulseAudio supplies clocking, format conversion, and native device lifecycle."""
    def __init__(self, directory):
        self.env = dict(os.environ, PULSE_SERVER="unix:" + str(directory / "pulse.sock"))
        self.processes = []
        self.capture_ids = []
        self.speaker_ids = []
        self.unclaimed_at = None
        self.microphone_buffer = bytearray()
        self.speaker_buffer = bytearray()
        try:
            self.start(directory)
        except BaseException:
            self.close()
            raise

    def start(self, directory):
        config = directory / "pulse.pa"
        config.write_text(
            f'load-module module-native-protocol-unix socket="{directory / "pulse.sock"}" auth-anonymous=1\n'
            'load-module module-null-sink sink_name=hive_microphone rate=48000 channels=1\n'
            'load-module module-null-sink sink_name=hive_speaker rate=48000 channels=1\n'
            'set-default-source hive_microphone.monitor\nset-default-sink hive_speaker\n')
        arguments = ["pulseaudio", "-n", "--file=" + str(config), "--daemonize=no", "--use-pid-file=no",
                     "--exit-idle-time=-1", "--disable-shm", "--log-target=stderr"]
        if os.environ.get("HIVE_AUDIO_PULSE_MODULE_PATH"):
            arguments.append("--dl-search-path=" + os.environ["HIVE_AUDIO_PULSE_MODULE_PATH"])
        self.server = self.spawn(arguments)
        deadline = time.monotonic() + 5
        while not (directory / "pulse.sock").exists():
            if self.server.poll() is not None or time.monotonic() > deadline:
                raise ValueError("Workspace audio server did not start")
            time.sleep(0.02)
        self.writer = self.spawn(["pacat", "--playback", "--device=hive_microphone", "--raw",
                                  "--rate=48000", "--channels=1", "--format=s16le",
                                  "--latency-msec=20", "--process-time-msec=10"], stdin=subprocess.PIPE)
        self.reader = self.spawn(["pacat", "--record", "--device=hive_speaker.monitor", "--raw",
                                  "--rate=48000", "--channels=1", "--format=s16le",
                                  "--latency-msec=20", "--process-time-msec=10"], stdout=subprocess.PIPE)
        self.events = self.spawn(["pactl", "subscribe"], stdout=subprocess.PIPE)
        for descriptor in (self.writer.stdin, self.reader.stdout, self.events.stdout):
            os.set_blocking(descriptor.fileno(), False)
        fcntl.fcntl(self.writer.stdin.fileno(), fcntl.F_SETPIPE_SZ, 4096)

    def spawn(self, arguments, **kwargs):
        process = subprocess.Popen(arguments, env=self.env, stderr=subprocess.DEVNULL,
                                   stdin=kwargs.pop("stdin", subprocess.DEVNULL),
                                   stdout=kwargs.pop("stdout", subprocess.DEVNULL), **kwargs)
        self.processes.append(process)
        return process

    def list(self, kind):
        result = subprocess.run(["pactl", "--format=json", "list", kind], env=self.env,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2, check=True)
        return json.loads(result.stdout)

    def refresh(self, broker):
        # The server starts empty: null sinks have indexes 0 (mic) and 1 (speaker).
        # Our own recording stream is on source 1 and cannot activate microphone.
        self.capture_ids = [row["index"] for row in self.list("source-outputs") if row["source"] == 0 and not row.get("corked", False)]
        self.speaker_ids = [row["index"] for row in self.list("sink-inputs") if row["sink"] == 1]
        active = bool(self.capture_ids)
        if active and not broker.owner:
            # Let a browser relay finish startup if /voice arrived first.
            if self.unclaimed_at is None:
                self.unclaimed_at = time.monotonic()
            elif time.monotonic() - self.unclaimed_at > 10:
                self.stop_native()
                active = False
        else:
            self.unclaimed_at = None
        before = broker.capturing
        broker.capturing = active
        if before != active:
            self.microphone_buffer.clear()
            self.speaker_buffer.clear()
            broker.active()

    def stop_native(self):
        # Terminating this session's server disconnects every native stream.
        # The next relay recreates devices at the same PULSE_SERVER path.
        if self.capture_ids or self.speaker_ids:
            self.server.terminate()
        self.capture_ids = self.speaker_ids = []
        self.microphone_buffer.clear()

    def append_microphone(self, pcm):
        self.microphone_buffer.extend(pcm)
        if len(self.microphone_buffer) > PACKET * 10:
            del self.microphone_buffer[:-PACKET * 10]

    def write_microphone(self):
        packet = bytes(self.microphone_buffer[:PACKET]).ljust(PACKET, b"\0")
        del self.microphone_buffer[:PACKET]
        try:
            os.write(self.writer.stdin.fileno(), packet)
        except BlockingIOError:
            pass  # Discard old samples during a stall.

    def close(self):
        for process in reversed(self.processes):
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def serve(session):
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    directory = state_directory(session)
    with (directory / "broker.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        path = directory / "bridge.sock"
        path.unlink(missing_ok=True)
        (directory / "pulse.sock").unlink(missing_ok=True)
        devices = PulseDevices(directory)
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, PACKET * 10)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        sock.bind(str(path))
        path.chmod(0o600)
        sock.setblocking(False)
        broker = Broker(sock, devices.append_microphone, devices.stop_native)
        idle_at = time.monotonic()
        next_microphone = idle_at
        next_refresh = idle_at + 1
        event_buffer = b""
        try:
            while True:
                ready, _, _ = select.select([sock, devices.reader.stdout, devices.events.stdout], [], [],
                                            max(0, min(0.01, next_microphone - time.monotonic())))
                now = time.monotonic()
                if sock in ready:
                    data, ancillary, flags, address = sock.recvmsg(PACKET + 1, socket.CMSG_SPACE(12))
                    credentials = [struct.unpack("3i", value) for level, kind, value in ancillary
                                   if level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS]
                    if not flags & socket.MSG_TRUNC and credentials and credentials[0][1] == os.getuid():
                        broker.handle(data, address, now)
                if devices.reader.stdout in ready:
                    data = os.read(devices.reader.stdout.fileno(), 4096)
                    if not data:
                        return
                    devices.speaker_buffer.extend(data)
                    while len(devices.speaker_buffer) >= PACKET:
                        packet = bytes(devices.speaker_buffer[:PACKET])
                        del devices.speaker_buffer[:PACKET]
                        if broker.capturing:
                            broker.send(b"P" + packet, broker.owner)
                if devices.events.stdout in ready:
                    data = os.read(devices.events.stdout.fileno(), 4096)
                    if not data:
                        return
                    event_buffer = (event_buffer + data)[-8192:]
                    if b"source-output" in event_buffer or b"sink-input" in event_buffer:
                        next_refresh = min(next_refresh, now + 0.05)
                    if b"\n" in event_buffer:
                        event_buffer = event_buffer.rsplit(b"\n", 1)[-1]
                if now >= next_refresh:
                    devices.refresh(broker)
                    next_refresh = now + 10  # Events normally update this immediately.
                if any(process.poll() is not None for process in devices.processes):
                    return
                if now >= next_microphone:
                    devices.write_microphone()
                    next_microphone += 0.01
                    if next_microphone < now - 0.04:
                        next_microphone = now  # Bound catch-up after a stalled control operation.
                broker.expire(now)
                if broker.owner or broker.capturing:
                    idle_at = now
                # Retain devices for a surviving tmux session, including reloads.
                if now - idle_at > 300:
                    result = subprocess.run(["tmux", "-L", "web", "has-session", "-t", f"={session}"],
                                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    if result.returncode:
                        return
                    idle_at = now
        finally:
            try:
                broker.release()
            finally:
                devices.close()
                sock.close()
                path.unlink(missing_ok=True)
                (directory / "pulse.sock").unlink(missing_ok=True)


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def relay(session):
    # PTY transports must not echo microphone frames or translate PCM framing.
    if os.isatty(sys.stdin.fileno()):
        tty.setraw(sys.stdin.fileno())
    prepare(session)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, PACKET * 10)
    sock.bind("")  # Linux autobinding assigns each relay a unique abstract address.
    sock.connect(str(state_directory(session) / "bridge.sock"))
    sock.setblocking(False)
    sock.send(b"B")
    buffer = b""
    last_browser = last_ping = time.monotonic()
    try:
        while True:
            ready, _, _ = select.select([sock, sys.stdin], [], [], 1)
            now = time.monotonic()
            if now - last_browser > OWNER_TIMEOUT:
                return
            if sock in ready:
                packet = sock.recv(PACKET + 1)
                if packet == b"R":
                    emit({"type": "ready"})
                elif packet == b"N":
                    emit({"type": "error", "code": "session_busy", "message": "Audio is already connected in another view of this terminal."})
                    return
                elif packet in (b"A", b"Z"):
                    emit({"type": "active", "active": packet == b"A"})
                elif packet[:1] == b"P":
                    emit({"type": "speaker", "pcm": base64.b64encode(packet[1:]).decode()})
            if sys.stdin in ready:
                chunk = os.read(sys.stdin.fileno(), 4096)
                if not chunk:
                    return
                buffer += chunk
                if len(buffer) > 8192:
                    return
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    try:
                        value = json.loads(line)
                        if value == {"type": "ping"}:
                            last_browser = now
                            emit({"type": "pong"})
                        elif value == {"type": "release"}:
                            return
                        elif value.get("type") == "microphone" and isinstance(value.get("pcm"), str):
                            pcm = base64.b64decode(value["pcm"], validate=True)
                            if not 0 < len(pcm) <= PACKET or len(pcm) % 2:
                                return
                            sock.send(b"M" + pcm)
                    except (ValueError, TypeError, AttributeError):
                        return
            if now - last_ping >= 5:
                sock.send(b"K")
                last_ping = now
    finally:
        try:
            sock.send(b"Q")
        except OSError:
            pass
        sock.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["prepare", "serve", "relay"])
    parser.add_argument("session")
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            print(prepare(args.session))
        elif args.command == "serve":
            serve(args.session)
        else:
            relay(args.session)
    except (OSError, ValueError):
        if args.command == "relay":
            emit({"type": "error", "message": "Workspace audio is unavailable. Update the workspace image and open a new terminal."})
        else:
            print("Hive audio device is unavailable", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
