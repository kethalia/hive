"""Check the image's tmux config using an isolated server, never the user's socket."""

import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


def main():
    config = Path(sys.argv[1]).resolve()
    # Fail before loading a regressed config that could restore the user's saved
    # commands into this test server or write their existing snapshot directory.
    assert not re.search(r"resurrect|continuum", config.read_text(), re.IGNORECASE)
    environment = dict(os.environ)
    environment.pop("TMUX", None)
    environment.pop("TMUX_PANE", None)

    with tempfile.TemporaryDirectory(prefix="hive-tmux-check-") as directory:
        socket = str(Path(directory) / "tmux.sock")

        def tmux(*arguments, **kwargs):
            return subprocess.run(
                ["tmux", "-S", socket, "-f", str(config), *arguments],
                env=environment,
                text=True,
                capture_output=True,
                timeout=10,
                **kwargs,
            )

        def command(*arguments, **kwargs):
            result = tmux(*arguments, **kwargs)
            assert result.returncode == 0, result.stderr
            return result.stdout

        try:
            command(
                "new-session", "-d", "-s", "hive-smoke", "-c", directory,
                "/bin/sh", "-c", "printf '%s\\n' hive-tmux-live-history; exec cat",
            )
            # tmux can parse a config with errors and still create a session.
            command("source-file", "-n", str(config))
            assert command("show-options", "-gv", "history-limit").strip() == "50000"
            settings = command("show-options", "-g") + command("show-hooks", "-g")
            bindings = command("list-keys")
            assert not re.search(r"resurrect|continuum", settings + bindings, re.IGNORECASE)
            assert "display-menu" in command("list-keys", "-T", "root", "F12")

            for _ in range(50):
                if "hive-tmux-live-history" in command("capture-pane", "-p", "-t", "hive-smoke"):
                    break
                time.sleep(0.02)
            else:
                raise AssertionError("The pane did not produce its live history marker")

            server = command("display-message", "-p", "#{pid}").strip()
            pane = command("display-message", "-p", "-t", "hive-smoke", "#{pane_pid}").strip()
            for _ in range(2):
                # Exercise the proxy's attach-or-create semantics with real tmux
                # control clients. Detaching must leave the original process alive.
                client = command(
                    "-C", "new-session", "-A", "-s", "hive-smoke", input="detach-client\n",
                )
                assert "%session-changed" in client, client
                command("has-session", "-t", "hive-smoke")
                assert command("display-message", "-p", "#{pid}").strip() == server
                assert command("display-message", "-p", "-t", "hive-smoke", "#{pane_pid}").strip() == pane
                assert "hive-tmux-live-history" in command("capture-pane", "-p", "-t", "hive-smoke")
        finally:
            tmux("kill-server")

    print("tmux: live process/history survive reconnects; menu retained; no snapshot hooks")


if __name__ == "__main__":
    main()
