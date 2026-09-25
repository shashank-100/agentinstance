#!/usr/bin/env python3
"""Render a recording at 1x, with the run's own clock burned in.

Frames were written as `<ms>.jpg` offsets from the moment the task was
dispatched, so replaying them at their original spacing is what makes the
result honest: the elapsed time on screen is the time the run actually took,
not a number chosen afterwards.

ffmpeg cannot read irregularly spaced filenames directly, so each frame is
held for exactly as long as the next one took to arrive, using a concat
demuxer script. A frame that arrived 400ms after its predecessor is shown for
400ms.

Usage:

    python3 scripts/render_demo.py recordings/demo-1
    python3 scripts/render_demo.py recordings/demo-1 --gif-width 1000

Writes docs/demo.mp4 and docs/demo.gif.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

# The GIF in a README does not need to be full width; 12fps is enough for a
# UI recording and keeps the file small enough that GitHub renders it inline.
GIF_FPS = 12
GIF_WIDTH = 1100
# How long the final frame is held, so the pull request is readable before the
# loop restarts.
END_HOLD_S = 2.0


def run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f"{cmd[0]} failed:\n{proc.stderr[-1500:]}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("recording", type=Path)
    ap.add_argument("--out-dir", type=Path, default=Path("docs"))
    ap.add_argument("--gif-width", type=int, default=GIF_WIDTH)
    ap.add_argument("--gif-fps", type=int, default=GIF_FPS)
    ap.add_argument("--no-gif", action="store_true")
    args = ap.parse_args()

    state_path = args.recording / "state.json"
    if not state_path.exists():
        sys.exit(f"no state.json in {args.recording} — is that a recording?")
    state = json.loads(state_path.read_text())

    # Refuse to render a run that did not produce a pull request. The recorder
    # already returns non-zero for this; repeating the check here stops an old
    # or hand-copied failure from quietly becoming a demo.
    verification = state.get("verification", {})
    if not verification.get("passed"):
        sys.exit(f"recording did not pass verification: {json.dumps(verification)}")

    frames = sorted(args.recording.glob("frames/*.jpg"))
    if len(frames) < 2:
        sys.exit(f"only {len(frames)} frames — nothing to render")

    times = [int(p.stem) / 1000.0 for p in frames]
    args.out_dir.mkdir(parents=True, exist_ok=True)

    # A concat script holding each frame for the gap until the next one. This
    # is what preserves 1x: a pause in the run is a pause in the video.
    lines = []
    for i, (path, t) in enumerate(zip(frames, times)):
        # Every frame is held until the next one arrived. The last is held for
        # END_HOLD_S so the pull request is readable before the loop restarts.
        # Each frame is held until the next arrived. The final frame gets a
        # nominal duration only: the end hold is applied afterwards with tpad,
        # because the concat demuxer's handling of the last entry is not
        # something to rely on (it re-applies that duration to the repeated
        # file, which silently added a second hold).
        gap = round(times[i + 1] - t, 3) if i + 1 < len(times) else 0.04
        lines.append(f"file '{path.resolve()}'\nduration {max(0.02, gap)}")
    # The concat demuxer needs the last file repeated to apply the entry before
    # it — but it then also plays that repeat, so the repeat carries no
    # `duration` line of its own. Giving it one adds a second end hold.
    lines.append(f"file '{frames[-1].resolve()}'")
    concat = args.recording / "concat.txt"
    concat.write_text("\n".join(lines) + "\n")

    mp4 = args.out_dir / "demo.mp4"
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", str(concat),
        # Hold the last frame so the pull request is readable before the loop
        # restarts, then resample onto a fixed rate. `-fps_mode vfr` looks like
        # the right answer here and is not: it keeps the frames but collapses
        # the gaps, rendering a 6s run as 2.8s.
        "-vf", f"tpad=stop_mode=clone:stop_duration={END_HOLD_S}",
        "-r", "30",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
        "-movflags", "+faststart",
        str(mp4),
    ])

    if not args.no_gif:
        gif = args.out_dir / "demo.gif"
        # Two passes: a palette generated from the actual frames, then applied.
        # A generic palette bands the board's flat UI colours badly.
        vf = (f"fps={args.gif_fps},scale={args.gif_width}:-1:flags=lanczos,"
              "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer")
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp4),
             "-vf", vf, "-loop", "0", str(gif)])
        size_mb = gif.stat().st_size / 1_000_000
        print(f"{gif}  {size_mb:.1f} MB")
        if size_mb > 10:
            print("  (over 10 MB — GitHub may not render it inline; "
                  "try --gif-width 900 or --gif-fps 10)")

    seconds = state.get("seconds", times[-1])
    print(f"{mp4}  {len(frames)} frames, {seconds:.1f}s at 1x")
    print(f"pull request: {verification.get('prUrl')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
