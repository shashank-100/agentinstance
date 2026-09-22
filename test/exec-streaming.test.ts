// ContainerSandbox.execStreaming, against the SSE shape the sandbox SDK emits.
//
// This is the path every agent run actually takes: `send` always passes an
// `onOutput`, so the harness calls execStreaming rather than exec. It shipped
// returning a hardcoded `exitCode: 0` while decoding the stream as raw bytes,
// which meant two things at once — watchers were shown the SSE envelope
// instead of the command's output, and a CLI that crashed or was killed by
// `timeout` was reported as a successful run whose partial output became the
// agent's reply.
//
// The failure list these cover, written before the code:
//   1. the `complete` event's exit code is ignored
//   2. a stream that ends without `complete` is called a success
//   3. stderr is folded into stdout, putting diagnostics in the reply
//   4. envelope text reaches watchers instead of command output
//   5. onChunk is never called, so nothing streams
//   6. a throwing onChunk kills the run
//   7. 124 is not distinguishable, so the harness cannot report a timeout
import { describe, it, expect } from "vitest";
import { ContainerSandbox } from "../src/sandbox/index.js";

/** One SSE frame, in the wire form `parseSSEStream` expects. */
const frame = (event: Record<string, unknown>): string =>
  `data: ${JSON.stringify(event)}\n\n`;

/**
 * A namespace whose sandbox streams `events` and nothing else.
 *
 * Stands in for the container binding: ContainerSandbox only ever reaches it
 * through `getSandbox`, which returns whatever `get()` yields.
 */
function streamingNs(events: Record<string, unknown>[]) {
  const box = {
    async execStream() {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          for (const e of events) controller.enqueue(enc.encode(frame(e)));
          controller.close();
        },
      });
    },
  };
  return {
    idFromName: () => ({}),
    get: () => box,
  } as never;
}

const run = (
  events: Record<string, unknown>[],
  onChunk: (t: string) => void = () => {},
) => new ContainerSandbox(streamingNs(events)).execStreaming("a1", "cmd", onChunk);

describe("execStreaming", () => {
  it("reports the exit code the complete event carries", async () => {
    const out = await run([
      { type: "start", command: "cmd" },
      { type: "stdout", data: "working…" },
      { type: "complete", exitCode: 3 },
    ]);
    // The original returned 0 here regardless, so a failed run read as a
    // successful one all the way up into the transcript.
    expect(out.exitCode).toBe(3);
    expect(out.success).toBe(false);
  });

  it("passes 124 through, so the harness can name a timeout", async () => {
    // `timeout` returns 124 when it kills the command, and the harness turns
    // that into "timed out after Ns" rather than an empty reply.
    const out = await run([{ type: "complete", exitCode: 124 }]);
    expect(out.exitCode).toBe(124);
  });

  it("treats a stream that never completes as a failure", async () => {
    const out = await run([{ type: "stdout", data: "half a line" }]);
    expect(out.success).toBe(false);
    expect(out.stdout).toBe("half a line");
    // The reason has to be legible: this is what someone sees when a run ends
    // for a reason the runner never reported.
    expect(out.stderr).toMatch(/exit status/);
  });

  it("keeps stderr out of stdout", async () => {
    const out = await run([
      { type: "stdout", data: "the answer" },
      { type: "stderr", data: "npm warn deprecated" },
      { type: "complete", exitCode: 0 },
    ]);
    // stdout becomes the agent's reply when the command succeeds, so a warning
    // folded into it is a warning the agent says out loud.
    expect(out.stdout).toBe("the answer");
    expect(out.stderr).toBe("npm warn deprecated");
  });

  it("streams both output streams to the watcher, and nothing else", async () => {
    const seen: string[] = [];
    await run(
      [
        { type: "start", command: "cmd" },
        { type: "stdout", data: "one " },
        { type: "stderr", data: "two " },
        { type: "complete", exitCode: 0 },
      ],
      (t) => seen.push(t),
    );
    // A CLI writes progress to stderr as often as stdout, so following only
    // one leaves a live run looking stalled. `start` and `complete` carry no
    // output and must not appear as though they did.
    expect(seen).toEqual(["one ", "two "]);
    expect(seen.join("")).not.toContain("data:");
  });

  it("survives a watcher that throws", async () => {
    const out = await run(
      [
        { type: "stdout", data: "still fine" },
        { type: "complete", exitCode: 0 },
      ],
      () => {
        throw new Error("the watcher blew up");
      },
    );
    // A failed observer is not a failed command: the run is what matters, and
    // whoever was watching can reconnect.
    expect(out.success).toBe(true);
    expect(out.stdout).toBe("still fine");
  });

  it("surfaces a runner error rather than an empty success", async () => {
    const out = await run([{ type: "error", error: "container went away" }]);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("container went away");
  });
});
