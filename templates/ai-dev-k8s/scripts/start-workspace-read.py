#!/usr/bin/env python3
"""Decode only the fixed, template-pinned installer; leave stdin for its request."""
import base64
import hashlib
from pathlib import Path
import re
import sys
import zlib


def decode_installer(encoded, checksum):
    if len(encoded) > 32768 or not re.fullmatch(rb"[a-f0-9]{64}\n?", checksum):
        raise ValueError("invalid installer")
    packed = base64.b64decode(encoded, validate=True)
    if len(packed) > 24576:
        raise ValueError("invalid installer")
    decoder = zlib.decompressobj(31)
    source = decoder.decompress(packed, 65537)
    if not decoder.eof or decoder.unused_data or decoder.unconsumed_tail or not 0 < len(source) <= 65536:
        raise ValueError("invalid installer")
    if hashlib.sha256(source).hexdigest().encode() != checksum.strip():
        raise ValueError("invalid installer")
    return source


def main():
    try:
        if len(sys.argv) != 1:
            raise ValueError("invalid arguments")
        root = Path("/opt/hive-workspace-read-template")
        with (root / "installer.gz.b64").open("rb") as stream:
            encoded = stream.read(32769)
        with (root / "installer.sha256").open("rb") as stream:
            checksum = stream.read(66)
        source = decode_installer(encoded, checksum)
        exec(compile(source, "<hive-workspace-read-installer>", "exec"), {"__name__": "__main__"})
    except Exception:
        sys.stderr.write("workspace_read_bootstrap_failed\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
