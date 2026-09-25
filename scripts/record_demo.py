#!/usr/bin/env python3
"""Record the board while a real task runs, as timestamped frames.

The demo this produces is one real run: a task filed through the public API,
an agent that clones a repository, edits it, pushes a branch and opens a pull
request. Frames come from inside Chrome over the DevTools Protocol rather than
from a screen recorder, so nothing but the page is ever captured — no desktop,
no notifications, no other windows.

Each frame is written as `<ms-since-epoch>.jpg`, where the epoch is the moment
the task is dispatched. That is what lets `render_demo.py` replay the run at
1x instead of guessing a frame rate.

Nothing is saved unless the run produced a pull request. A demo of a run that
did not work is worse than no demo.

Usage:

    # Chrome must be running with remote debugging on:
    #   /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\
    #     --remote-debugging-port=9222 --user-data-dir=/tmp/demo-chrome

    export AGENTINSTANCE_URL=https://your-worker.workers.dev
    export BOARD_URL=https://your-board.workers.dev
    export FLEET_TOKEN=...
    python3 scripts/record_demo.py \\
        --repo you/your-repo \\
        --goal "Fix slugify: punctuation, repeated spaces, leading dashes." \\
        --out recordings/demo-1
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

# A run that has not opened a pull request by now is not a demo.
DEFAULT_TIMEOUT_S = 900
# How often the board is polled for state. The page itself refreshes on its own
# timer; this is only for deciding when the run is over.
POLL_S = 2.0
# Screencast quality. maxWidth is the board's useful width — larger frames cost
# disk and buy nothing once the GIF is scaled down.
FRAME_QUALITY = 80
FRAME_MAX_W = 1440
FRAME_MAX_H = 900


def api(url: str, path: str, token: str | None, method: str = "GET",
        body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{url}{path}", data=data, method=method)
    req.add_header("content-type", "application/json")
    if token:
        req.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read() or "{}")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path}: {e.code} {e.read().decode()[:200]}")
    except urllib.error.URLError as e:
        raise SystemExit(f"{method} {path} unreachable: {e.reason}")


class Chrome:
    """A DevTools Protocol connection to one tab.

    Frames arrive as `Page.screencastFrame` events with the page's own
    timestamps. Capturing here rather than with a screen recorder is what keeps
    everything outside the browser tab — desktop, notifications, other windows —
    out of the recording entirely.
    """

    def __init__(self, port: int) -> None:
        try:
            import websocket  # type: ignore
        except ImportError:
            raise SystemExit(
                "needs websocket-client: pip install websocket-client\n"
                "(or: uv pip install websocket-client)"
            )
        self._ws_mod = websocket
        tabs = json.loads(
            urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=10).read()
        )
        page = next((t for t in tabs if t.get("type") == "page"), None)
        if not page:
            raise SystemExit(f"no page tab on port {port}; is Chrome running with "
                             f"--remote-debugging-port={port}?")
        self.ws = websocket.create_connection(page["webSocketDebuggerUrl"],
                                              timeout=30, max_size=64 * 1024 * 1024)
        self.next_id = 0
        self.frames: list[dict] = []
        self.lock = threading.Lock()

    def call(self, method: str, **params) -> dict:
        """One command. Screencast frames arriving meanwhile are buffered, not
        dropped: they are the recording."""
        self.next_id += 1
        want = self.next_id
        self.ws.send(json.dumps({"id": want, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == want:
                return msg.get("result", {})
            if msg.get("method") == "Page.screencastFrame":
                with self.lock:
                    self.frames.append(msg["params"])

    def drain(self) -> list[dict]:
        with self.lock:
            out, self.frames = self.frames, []
        return out

    def close(self) -> None:
        try:
            self.ws.close()
        except Exception:
            pass


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--goal", required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out", type=Path, required=True, help="recording directory")
    ap.add_argument("--url", default=os.environ.get("AGENTINSTANCE_URL", ""))
    ap.add_argument("--board", default=os.environ.get("BOARD_URL", ""))
    ap.add_argument("--token", default=os.environ.get("FLEET_TOKEN"))
    ap.add_argument("--port", type=int, default=9222)
    ap.add_argument("--harness", default="claude-code")
    ap.add_argument("--machine", default="one-cpu")
    ap.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_S)
    args = ap.parse_args()

    if not args.url:
        raise SystemExit("set AGENTINSTANCE_URL or pass --url")
    if not args.token:
        raise SystemExit("set FLEET_TOKEN or pass --token")
    url = args.url.rstrip("/")
    board = (args.board or url).rstrip("/")

    # Refuse to overwrite: a recording is evidence, and silently replacing one
    # loses the run it documented.
    args.out.mkdir(parents=True, exist_ok=False)
    frames_dir = args.out / "frames"
    frames_dir.mkdir()

    # Which code this recording is of. Without it a demo is a claim about a
    # version nobody can identify later.
    root = Path(__file__).resolve().parents[1]
    hashes = {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted((root / "src").rglob("*.ts"))
    }
    commit = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"],
                            capture_output=True, text=True).stdout.strip()

    chrome = Chrome(args.port)
    print(f"connected to Chrome on {args.port}", flush=True)

    # File the task first: the run is the thing being timed, and the page
    # should be showing it before the first frame is kept.
    filed = api(url, "/api/fleet/tasks", args.token, "POST", {
        "goal": args.goal, "repo": args.repo,
        "harness": args.harness, "machine": args.machine, "dispatch": True,
    })
    if filed.get("error"):
        raise SystemExit(f"refused: {filed['error']}")
    task_id = filed.get("id")
    agent_id = filed.get("assignedTo") or f"task-{task_id}"
    print(f"task {task_id} → agent {agent_id}", flush=True)

    chrome.call("Page.enable")
    chrome.call("Page.navigate", url=f"{board}/tasks/{task_id}")
    time.sleep(3.0)  # let the route render before the timer starts

    chrome.call("Page.startScreencast", format="jpeg", quality=FRAME_QUALITY,
                maxWidth=FRAME_MAX_W, maxHeight=FRAME_MAX_H, everyNthFrame=2)

    # Everything after this point is timed. Frames are named by their offset
    # from here, which is what makes a 1x replay possible.
    epoch = time.time()
    events: list[dict] = []
    state = None
    kept = 0
    deadline = epoch + args.timeout

    def keep_frames() -> None:
        nonlocal kept
        for p in chrome.drain():
            ms = max(0, int((time.time() - epoch) * 1000))
            (frames_dir / f"{ms:07d}.jpg").write_bytes(base64.b64decode(p["data"]))
            kept += 1
            try:
                chrome.call("Page.screencastFrameAck", sessionId=p["sessionId"])
            except Exception:
                pass

    try:
        while time.time() < deadline:
            keep_frames()
            time.sleep(POLL_S)

            task = api(url, f"/api/fleet/tasks/{task_id}", args.token)
            if task.get("state") != state:
                state = task.get("state")
                at = round(time.time() - epoch, 2)
                events.append({"t": at, "state": state})
                print(f"[{at:7.2f}s] {state}", flush=True)
            if task.get("prUrl") and not any("prUrl" in e for e in events):
                at = round(time.time() - epoch, 2)
                events.append({"t": at, "prUrl": task["prUrl"]})
                print(f"[{at:7.2f}s] {task['prUrl']}", flush=True)

            if state in ("settled", "failed"):
                time.sleep(1.5)   # let the page paint the final state
                keep_frames()
                break
    finally:
        try:
            chrome.call("Page.stopScreencast")
        except Exception:
            pass
        keep_frames()

    elapsed = round(time.time() - epoch, 2)
    task = api(url, f"/api/fleet/tasks/{task_id}", args.token)
    verification = {
        "passed": task.get("state") == "settled" and bool(task.get("prUrl")),
        "state": task.get("state"),
        "prUrl": task.get("prUrl"),
        "branch": task.get("branch"),
    }
    (args.out / "state.json").write_text(json.dumps({
        "goal": args.goal, "repo": args.repo, "task": task_id, "agent": agent_id,
        "seconds": elapsed, "frames": kept, "events": events,
        "verification": verification, "commit": commit, "source_hashes": hashes,
    }, indent=2))
    chrome.close()

    print(f"\n{kept} frames over {elapsed:.1f}s → {args.out}")
    print(json.dumps(verification, indent=2))

    # The same rule the run itself follows: no pull request, no demo.
    if not verification["passed"]:
        print("\nverification failed — do not render this recording", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
