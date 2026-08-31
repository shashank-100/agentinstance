// Bridges the agent's capabilities into its VM.
//
// The CLI harness runs a real agent CLI inside the container, and that CLI
// brings its own tools — bash, file editing, its own loop. What it cannot see
// are the capabilities that live out in the Worker: web search, page
// rendering, and the agent's durable notes, none of which exist inside the
// container.
//
// The bridge is deliberately boring: each capability becomes a small shell
// script on PATH that curls the agent's own REST endpoint. The CLI then calls
// `search_web "..."` the way it would call any other command, and the request
// is served by the same `/agents/:id/tool/:name` route the REST API already
// exposes. No new protocol, no callback channel — the endpoint was already
// there and already enforced the per-agent capability gate.
import type { Sandbox } from "../sandbox/index.js";

/** Where the scripts land. Already on PATH for every shell in the image. */
const BIN_DIR = "/usr/local/bin";

/** Base64 for a UTF-8 string, without Node's Buffer (this runs in a Worker). */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Capabilities worth exposing as commands, with the shape of their call.
 *
 * `run_shell` is absent on purpose: the CLI already has a real shell, and
 * routing bash back out through the Worker would be slower and strictly worse.
 * `fetch_json` and `scrape_web` are absent for the same reason — `curl` is
 * right there.
 */
const VM_TOOLS: Record<string, { usage: string; fields: string[] }> = {
  // `fields` names the JSON keys, in argument order. A trailing "*" means that
  // field takes the rest of the line, so a query or a note can contain spaces
  // without the caller quoting it.
  search_web: { usage: 'search_web <query>', fields: ["query*"] },
  browse_page: { usage: "browse_page <url>", fields: ["url"] },
  remember: { usage: 'remember <key> <value...>', fields: ["key", "value*"] },
  recall: { usage: "recall [key]", fields: ["key"] },
};

/**
 * The script body.
 *
 * Python assembles the JSON and performs the POST in one step. An earlier
 * version built the body in shell and escaped it into a `curl -d` argument;
 * quoting it correctly through two layers of shell proved impossible to get
 * right, and the failure mode was a script that hung rather than one that
 * errored. Handing the arguments to Python as argv sidesteps quoting entirely.
 */
function scriptBody(endpoint: string, tool: string, fields: string[]): string {
  const spec = JSON.stringify(fields);
  return [
    `exec python3 - "$@" <<'PY'`,
    "import json, sys, urllib.request",
    `fields = ${spec}`,
    "args = sys.argv[1:]",
    "payload = {}",
    "for i, field in enumerate(fields):",
    "    rest = field.endswith('*')",
    "    key = field.rstrip('*')",
    "    if rest:",
    "        value = ' '.join(args[i:])",
    "    else:",
    "        value = args[i] if i < len(args) else ''",
    "    if value:",
    "        payload[key] = value",
    `req = urllib.request.Request(`,
    `    "${endpoint}/tool/${tool}",`,
    "    data=json.dumps(payload).encode(),",
    "    headers={",
    '        "content-type": "application/json",',
    // Cloudflare's bot protection rejects urllib's default user agent with a
    // 403 before the request ever reaches the Worker.
    '        "user-agent": "agentinstance-vm-tool/1.0",',
    "    },",
    ")",
    "try:",
    "    with urllib.request.urlopen(req, timeout=60) as r:",
    "        body = json.load(r)",
    "except Exception as e:",
    "    print(f'{e}', file=sys.stderr)",
    "    sys.exit(1)",
    "# Unwrap { result: ... }: the tool's own output is what the caller wants.",
    "out = body.get('result', body) if isinstance(body, dict) else body",
    "print(out if isinstance(out, str) else json.dumps(out, indent=2))",
    "PY",
    "",
  ].join("\n");
}

/**
 * Standing instructions. Tools say what the agent *can* do; this says when it
 * *should* — an agent that has `recall` but never thinks to call it before
 * answering is no better off than one without it.
 */
export function toolInstructions(enabled: string[]): string {
  const has = (n: string) => enabled.includes(n);
  const lines: string[] = [
    "# Your tools",
    "",
    "These are real commands on your PATH, not suggestions. Run them with bash.",
    "",
  ];
  if (has("search_web")) {
    lines.push(
      '- `search_web "<query>"` — search the web. Use it for current facts,',
      "  companies, people, prices, or anything after your training cutoff.",
      "  Prefer it over answering from memory when the answer could be stale.",
      "",
    );
  }
  if (has("browse_page")) {
    lines.push(
      '- `browse_page "<url>"` — render a page and return its text. Use it when',
      "  you need what is actually on a specific page, not a search summary.",
      "",
    );
  }
  if (has("remember")) {
    lines.push(
      '- `remember <key> "<value>"` — save a note that outlives this session.',
      "  Use it for findings, decisions, and anything you should not have to",
      "  work out twice. Writing the same key again replaces it.",
      "",
    );
  }
  if (has("recall")) {
    lines.push(
      "- `recall [key]` — read notes you saved before. **Run this before",
      "  answering anything that might depend on earlier sessions**; you start",
      "  each session with no memory of the last one except these notes.",
      "",
    );
  }
  return lines.join("\n");
}

/**
 * Install the enabled capabilities as commands in the VM.
 *
 * Re-run every session: a container's filesystem does not survive sleeping, so
 * anything written here is gone by the next message.
 */
export async function installVmTools(
  sandbox: Sandbox,
  agentId: string,
  agentUrl: string,
  enabled: string[],
): Promise<void> {
  const scripts = enabled.filter((name) => name in VM_TOOLS);
  if (!scripts.length) return;

  const writes = scripts
    .map((name) => {
      const tool = VM_TOOLS[name];
      // recall is the one tool that is meaningful with no arguments: it lists
      // recent notes.
      const requiresArgs = name !== "recall";
      const script =
        `#!/bin/sh\n` +
        `# ${tool.usage}\n` +
        (requiresArgs
          ? `if [ $# -eq 0 ]; then echo "usage: ${tool.usage}" >&2; exit 2; fi\n`
          : "") +
        scriptBody(agentUrl, name, tool.fields);
      // base64, not a heredoc: the script contains a heredoc of its own, and
      // nesting one inside the sandbox's exec hangs waiting on stdin that never
      // arrives. Encoding sidesteps quoting and nesting in one step.
      const encoded = base64(script);
      return `printf %s ${encoded} | base64 -d > ${BIN_DIR}/${name} && chmod 755 ${BIN_DIR}/${name}`;
    })
    .join(" && ");

  await sandbox.exec(agentId, writes);
}
