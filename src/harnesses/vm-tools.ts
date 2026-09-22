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
  // Agent-to-agent. `to` is the agent's name as it appears in /agents/:id —
  // the sender's own name is not a field here: it is stamped by the Worker
  // from the calling agent's spec, so an agent cannot claim to be another.
  send_to_agent: { usage: "send_to_agent <agent> <message...>", fields: ["to", "text*"] },
  list_agents: { usage: "list_agents", fields: [] },
  // The work queue. `action` first so the bare command claims the next task,
  // which is the common case.
  fleet_task: {
    usage: "fleet_task [claim|list|get|branch|pr|settle|fail] [id] [value...]",
    fields: ["action", "id", "value*"],
  },
  // One generic `arg` rather than a field per action: the script maps
  // arguments to fields by position, so naming them repo/name/message would
  // put `git_repo branch my-feature` into `repo`. The Worker knows which one
  // each action means.
  git_repo: {
    usage: "git_repo <clone|branch|commit|push|status|diff> [argument...]",
    fields: ["action", "arg*"],
  },
  open_pr: {
    usage: "open_pr <owner/name> <branch> <title...>",
    fields: ["repo", "head", "title*"],
  },
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
  // The endpoint may carry a token as a query string. The tool name is a path
  // segment, so it has to go before that query, not after it.
  const cut = endpoint.indexOf("?");
  const url =
    cut === -1
      ? `${endpoint}/tool/${tool}`
      : `${endpoint.slice(0, cut)}/tool/${tool}${endpoint.slice(cut)}`;
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
    `    "${url}",`,
    "    data=json.dumps(payload).encode(),",
    "    headers={",
    '        "content-type": "application/json",',
    // Cloudflare's bot protection rejects urllib's default user agent with a
    // 403 before the request ever reaches the Worker.
    '        "user-agent": "agentinstance-vm-tool/1.0",',
    "    },",
    ")",
    "try:",
    // No timeout. A tool call from inside the VM can land on an agent whose
    // container is asleep, and the Worker does not answer until that container
    // has booted — so any fixed number is really a guess about boot time, not
    // about the work. 60s guessed wrong: a `git_repo clone` of a 100KB repo
    // failed six times in a row, reading as "git is broken" rather than "the
    // machine was still starting".
    //
    // The harness already caps the whole CLI session, so a call that truly
    // never returns is bounded there rather than here.
    "    with urllib.request.urlopen(req) as r:",
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
  if (has("send_to_agent") || has("list_agents")) {
    // Without this an agent treats an inbound a2a message as malformed input:
    // asked a plain question tagged "[from agent x]", one answered correctly
    // and then flagged the tag as unusual framing it had not expected.
    lines.push(
      "You are one of several agents, and you can talk to the others.",
      "",
      'A message beginning `[from agent <name>]` is another agent addressing you',
      "directly. That is normal. Answer it as you would any request, and reply to",
      "that agent rather than remarking on the format.",
      "",
    );
  }
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
  if (has("send_to_agent")) {
    lines.push(
      '- `send_to_agent <agent> "<message>"` — send a message to another agent',
      "  and get its reply. Use it to delegate work, ask for a review, or report",
      "  back to whoever delegated to you. The other agent has its own memory and",
      "  its own machine; it does not see this conversation, so say enough for it",
      "  to act without context.",
      "",
    );
  }
  if (has("list_agents")) {
    lines.push(
      "- `list_agents` — list the other agents you can reach, with their models.",
      "  Run it before delegating so you address an agent that exists.",
      "",
    );
  }
  if (has("fleet_task")) {
    lines.push(
      "- `fleet_task` — claim the next task from the queue. Then:",
      "  `fleet_task branch <id> <branch-name>` and `fleet_task pr <id> <url>` to",
      "  record what you produced, and `fleet_task settle <id> <summary>` when the",
      "  work is done (or `fail <id> <reason>`). **Settle every task you claim** —",
      "  a task left running blocks nothing but tells everyone it is still in",
      "  progress.",
      "",
    );
  }
  if (has("git_repo")) {
    lines.push(
      "- `git_repo clone <owner/name>` — clone into /workspace/repo. Then",
      "  `git_repo branch <name>`, `git_repo commit <message>`, `git_repo push`.",
      "  **Push before you finish.** This machine's disk is wiped when it goes",
      "  idle, so anything unpushed is lost — commit and push as you go rather",
      "  than saving it all for the end.",
      "",
    );
  }
  if (has("open_pr")) {
    lines.push(
      '- `open_pr <owner/name> <branch> "<title>"` — open a pull request. Push',
      "  the branch first; a PR for a branch that is not on the remote fails.",
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
      const requiresArgs =
        name !== "recall" && name !== "list_agents" && name !== "fleet_task";
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
