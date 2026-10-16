#!/usr/bin/env python3
"""Send only lifecycle metadata to Hive; never prompts, transcripts, or tool arguments."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import urllib.error


def classify(event):
    name = event.get("hook_event_name")
    tool = event.get("tool_name", "")
    if name == "PreToolUse" and tool in (
        "AskUserQuestion", "ExitPlanMode", "request_user_input", "request_user_input_async"
    ):
        return "question"
    if name == "PermissionRequest":
        return "approval"
    if name == "Notification" and event.get("notification_type") in (
        "permission_prompt", "elicitation_dialog", "agent_needs_input"
    ):
        return "approval" if event["notification_type"] == "permission_prompt" else "question"
    if name == "StopFailure":
        return "failure"
    if name == "Stop":
        return "ready"
    return None


def project_name(directory):
    """Use repository metadata only; never send absolute paths or Git remotes."""
    if not isinstance(directory, str) or not directory:
        return ""
    try:
        root = subprocess.check_output(
            ["git", "-C", directory, "rev-parse", "--show-toplevel"],
            timeout=0.5, stderr=subprocess.DEVNULL, text=True,
        ).strip()
    except (OSError, subprocess.SubprocessError):
        root = directory
    return " ".join(Path(root).name.split())[:200]


def main():
    agent = sys.argv[1]
    event = json.load(sys.stdin)
    kind = classify(event)
    if not kind:
        return
    config = json.loads((Path(__file__).parent / "config.json").read_text())
    try:
        session = subprocess.check_output(
            ["tmux", "display-message", "-p", "-t", os.environ.get("TMUX_PANE", ""), "#S"],
            timeout=1, stderr=subprocess.DEVNULL, text=True,
        ).strip() if os.environ.get("TMUX_PANE") else ""
    except (OSError, subprocess.SubprocessError):
        session = ""
    identity = "|".join(str(event.get(key, "")) for key in (
        "session_id", "turn_id", "tool_use_id", "hook_event_name", "notification_type"
    ))
    # The same delivery can be retried safely; separate turns without turn IDs
    # receive a new id. No prompt or tool content leaves the workspace.
    event_id = hashlib.sha256((identity + str(time.time_ns())).encode()).hexdigest()
    body = json.dumps({"kind": kind, "agent": agent, "eventId": event_id,
                       "sessionName": session[:200],
                       "projectName": project_name(event.get("cwd") or os.getcwd())}).encode()
    request = urllib.request.Request(config["url"], data=body, headers={
        "Authorization": "Bearer " + config["token"], "Content-Type": "application/json",
        "User-Agent": "Hive-Agent-Notifications/1.0",
    })
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    opener = urllib.request.build_opener(NoRedirect)
    # Hooks never change approval decisions or block the agent on network failure.
    for attempt in range(2):
        try:
            with opener.open(request, timeout=3) as response:
                response.read(1024)
            return
        except urllib.error.HTTPError as error:
            if error.code < 500 and error.code != 429:
                return
        except (OSError, ValueError):
            if attempt == 0:
                time.sleep(0.2)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
