#!/usr/bin/env node
// Feature #12 — the `nimbus` CLI. Talks to a deployed Nimbus worker over REST.
//
// Usage:
//   nimbus --url https://nimbus.you.workers.dev launch <id> [--harness chat --model claude-sonnet-4-6]
//   nimbus send <id> "hello"
//   nimbus history <id>
//   nimbus status <id>
//   nimbus park <id> | nimbus unpark <id>
//   nimbus snapshot <id> > backup.json
//   nimbus clone <id> ./agent.json      # push a local agent (spec+history) to the cloud
//
// Config: --url flag or NIMBUS_URL env. Optional NIMBUS_TOKEN -> Authorization header.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}
const BASE = (flag("url", process.env.NIMBUS_URL) || "").replace(/\/$/, "");
const TOKEN = process.env.NIMBUS_TOKEN;
if (!BASE) fail("set --url or NIMBUS_URL to your Nimbus worker URL");

const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const [cmd, id, ...rest] = positional;

function fail(msg) {
  console.error(`nimbus: ${msg}`);
  process.exit(1);
}
async function api(path, method = "GET", body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) fail(`${res.status} ${JSON.stringify(data)}`);
  return data;
}

switch (cmd) {
  case "launch": {
    const spec = {
      harness: flag("harness", "chat"),
      model: flag("model", "claude-sonnet-4-6"),
      machine: flag("machine", "4gb"),
    };
    console.log(JSON.stringify(await api(`/agents/${id}/configure`, "POST", spec), null, 2));
    break;
  }
  case "send":
    console.log((await api(`/agents/${id}/send`, "POST", { text: rest.join(" "), channel: "cli" })).reply);
    break;
  case "history":
    console.log(JSON.stringify(await api(`/agents/${id}/history`), null, 2));
    break;
  case "status":
    console.log(JSON.stringify(await api(`/agents/${id}/status`), null, 2));
    break;
  case "park":
    await api(`/agents/${id}/park`, "POST");
    console.log(`parked ${id}`);
    break;
  case "unpark":
    await api(`/agents/${id}/unpark`, "POST");
    console.log(`unparked ${id}`);
    break;
  case "snapshot":
    console.log(JSON.stringify(await api(`/agents/${id}/snapshot`), null, 2));
    break;
  case "clone": {
    // Push a locally-defined agent (spec + optional history) into the cloud.
    const file = rest[0];
    if (!file) fail("usage: nimbus clone <id> <local-agent.json>");
    const local = JSON.parse(readFileSync(file, "utf8"));
    await api(`/agents/${id}/restore`, "POST", {
      spec: local.spec,
      history: local.history ?? [],
      kv: local.kv ?? {},
    });
    console.log(`cloned local agent into cloud as '${id}' ✔`);
    break;
  }
  default:
    console.log(`nimbus — always-on agents CLI

commands:
  launch <id> [--harness --model --machine]
  send <id> "text"
  history <id>
  status <id>
  park <id> | unpark <id>
  snapshot <id>
  clone <id> <local-agent.json>

config: --url <workerUrl> or NIMBUS_URL, optional NIMBUS_TOKEN`);
}
