#!/usr/bin/env python3
"""Record one real agent run, with timestamps, ending on a pull request.

The demo this produces is an actual run against a real repository, not a
staged capture: the task is filed through the public API, the agent's own CLI
output is streamed as it arrives, and the run ends when the queue says the task
is settled and carries a pull request URL.

Timing starts when the task is dispatched and includes everything the agent
does — cloning, model calls, editing, pushing, opening the pull request. A
`--trace` file records the raw events with their original timestamps so a
render can replay the run at 1x afterwards rather than trusting a stopwatch.

Usage:

    export AGENTINSTANCE_URL=https://your-worker.workers.dev
    export FLEET_TOKEN=...            # or sign in and pass --cookie
    python3 scripts/record_run.py \\
        --repo you/your-repo \\
        --goal "Fix slugify: punctuation, repeated spaces, leading dashes." \\
        --trace recordings/run-1

Exits non-zero if the run does not reach a pull request, so a demo that did
not actually work cannot be rendered by accident.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# A run that has not produced a pull request in this long is not a demo.
DEFAULT_TIMEOUT_S = 900
# The board's own polling cadence. Faster adds requests without adding detail:
# the agent's output arrives in chunks, not per character.
POLL_S = 2.0


class Recorder:
    """Collects timestamped events for a later render."""

    def __init__(self, trace_dir: Path | None) -> None:
        self.started = time.time()
        self.events: list[dict] = []
        self.trace_dir = trace_dir
        if trace_dir:
            trace_dir.mkdir(parents=True, exist_ok=True)

    def at(self) -> float:
        """Seconds since the run began, which is what the demo counts."""
        return round(time.time() - self.started, 3)

    def event(self, kind: str, **fields) -> dict:
        ev = {"t": self.at(), "kind": kind, **fields}
        self.events.append(ev)
        return ev

    def say(self, kind: str, line: str, **fields) -> None:
        ev = self.event(kind, **fields)
        print(f"[{ev['t']:7.3f}s] {line}", flush=True)

    def save(self, outcome: dict) -> Path | None:
        if not self.trace_dir:
            return None
        path = self.trace_dir / "trace.json"
        path.write_text(
            json.dumps(
                {"startedAt": self.started, "outcome": outcome, "events": self.events},
                indent=2,
            )
        )
        return path


def api(url: str, path: str, token: str | None, cookie: str | None,
        method: str = "GET", body: dict | None = None) -> dict:
    """One API call, with whichever credential this deployment wants.

    A person's session cookie and an agent's FLEET_TOKEN are both accepted by
    the Worker, so a demo can be recorded either signed in or from a script.
    """
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{url}{path}", data=data, method=method)
    req.add_header("content-type", "application/json")
    if token:
        req.add_header("authorization", f"Bearer {token}")
    if cookie:
        req.add_header("cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read() or "{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        raise SystemExit(f"{method} {path} failed: {e.code} {detail}")
    except urllib.error.URLError as e:
        raise SystemExit(f"{method} {path} unreachable: {e.reason}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--goal", required=True, help="what the agent should do")
    ap.add_argument("--repo", required=True, help="owner/name to work against")
    ap.add_argument("--url", default=os.environ.get("AGENTINSTANCE_URL", ""))
    ap.add_argument("--token", default=os.environ.get("FLEET_TOKEN"))
    ap.add_argument("--cookie", default=os.environ.get("AGENTINSTANCE_COOKIE"))
    ap.add_argument("--harness", default="claude-code")
    ap.add_argument("--machine", default="one-cpu")
    ap.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_S)
    ap.add_argument("--trace", type=Path, help="directory for trace.json")
    args = ap.parse_args()

    if not args.url:
        raise SystemExit("set AGENTINSTANCE_URL or pass --url")
    url = args.url.rstrip("/")
    if not args.token and not args.cookie:
        raise SystemExit("need FLEET_TOKEN or AGENTINSTANCE_COOKIE to file a task")

    rec = Recorder(args.trace)
    rec.say("start", f"filing: {args.goal[:70]}", goal=args.goal, repo=args.repo)

    filed = api(url, "/api/fleet/tasks", args.token, args.cookie, "POST", {
        "goal": args.goal,
        "repo": args.repo,
        "harness": args.harness,
        "machine": args.machine,
        "dispatch": True,
    })
    if filed.get("error"):
        raise SystemExit(f"the deployment refused the task: {filed['error']}")

    task_id = filed.get("id") or (filed.get("task") or {}).get("id")
    if not task_id:
        raise SystemExit(f"no task id in the reply: {json.dumps(filed)[:200]}")
    # `dispatchTask` reports the agent it created as `assignedTo`. The
    # `task-<id>` fallback is the name it derives, kept only so a task that was
    # filed queued and started separately still records something usable.
    agent_id = filed.get("assignedTo") or f"task-{task_id}"
    rec.say("dispatched", f"task {task_id} → agent {agent_id}",
            task=task_id, agent=agent_id)

    # Poll the queue for the outcome and the agent for what it is saying. The
    # two are separate on purpose: a task can settle while output is still
    # draining, and the demo wants the last words the agent actually wrote.
    seen = 0
    state = None
    deadline = time.time() + args.timeout
    while time.time() < deadline:
        time.sleep(POLL_S)

        out = api(url, f"/agents/{agent_id}/output?since={seen}",
                  args.token, args.cookie)
        for chunk in out if isinstance(out, list) else []:
            seen = max(seen, int(chunk.get("seq", seen)))
            text = (chunk.get("text") or "").strip()
            for line in text.splitlines():
                if line.strip():
                    rec.say("output", line.rstrip()[:160], seq=seen)

        task = api(url, f"/api/fleet/tasks/{task_id}", args.token, args.cookie)
        now = task.get("state")
        if now != state:
            state = now
            rec.say("state", f"state → {state}", state=state)
        if task.get("branch") and not any(
            e["kind"] == "branch" for e in rec.events
        ):
            rec.say("branch", f"branch {task['branch']}", branch=task["branch"])
        if task.get("prUrl") and not any(e["kind"] == "pr" for e in rec.events):
            rec.say("pr", f"pull request {task['prUrl']}", prUrl=task["prUrl"])

        if state in ("settled", "failed"):
            outcome = {
                "state": state,
                "task": task_id,
                "agent": agent_id,
                "branch": task.get("branch"),
                "prUrl": task.get("prUrl"),
                "seconds": rec.at(),
                "result": task.get("result"),
            }
            rec.say("done", f"{state} in {rec.at():.1f}s", **outcome)
            trace = rec.save(outcome)
            if trace:
                print(f"\ntrace: {trace}")

            # The artifact is the pull request. A settled task without one is a
            # run that did not finish the job, whatever the queue calls it.
            if state == "settled" and outcome["prUrl"]:
                print(f"\n{outcome['prUrl']}  ({outcome['seconds']:.1f}s)")
                return 0
            print(f"\nno pull request: {state}", file=sys.stderr)
            return 1

    rec.say("timeout", f"no outcome in {args.timeout:.0f}s")
    rec.save({"state": "timeout", "seconds": rec.at()})
    return 1


if __name__ == "__main__":
    sys.exit(main())
