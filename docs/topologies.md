# Multi-agent topologies

There is no "supervisor" type in this codebase, and no "worker" type. There is
one primitive — an agent can message another agent — and the shapes below are
what you get by pointing it in different directions.

Every one of them is the same two capabilities:

```
send_to_agent <agent> "<message>"   # message another agent, get its reply
list_agents                          # who else exists
```

Enable them per agent like any other capability, and describe the protocol in
that agent's `agents-md`. The difference between a supervisor and a worker is
what its instructions say, not what it is.

## Why this is a capability and not a feature

`from` is stamped by the Worker from the sending agent's own spec, never from
what the agent passes in — so an agent cannot claim to be another one. The
message lands in the recipient's history on the `a2a` channel, which is the
same history its human conversations use: an agent has one memory across every
channel it is reached on.

Hops are capped (three by default). Two agents that message each other would
otherwise run until something stopped them, and every hop is a model call on a
booted container.

---

## 1. Supervisor and workers

One agent splits a goal and hands pieces out. The workers do not know about
each other.

```
        ┌─────────────┐
        │ supervisor  │   claude-code / claude-opus-5
        └──┬───┬───┬──┘
           │   │   │      send_to_agent
      ┌────┘   │   └────┐
   ┌──▼──┐  ┌──▼──┐  ┌──▼──┐
   │ w-1 │  │ w-2 │  │ w-3 │   pi / kimi-k3
   └─────┘  └─────┘  └─────┘
```

Launch them:

```sh
curl -X POST $URL/api/launch -d '{
  "id": "supervisor", "harness": "claude-code", "model": "claude-opus-5",
  "capabilities": ["send_to_agent", "list_agents", "remember", "recall"]
}'

for i in 1 2 3; do
  curl -X POST $URL/api/launch -d "{
    \"id\": \"w-$i\", \"harness\": \"pi\", \"model\": \"kimi-k3\",
    \"capabilities\": [\"send_to_agent\", \"run_shell\", \"search_web\"]
  }"
done
```

Give the supervisor its protocol:

```sh
curl -X POST $URL/agents/supervisor/agents-md -d '{"content":
"You coordinate w-1, w-2 and w-3.

Run list_agents first to see who is available.
Split the goal into independent pieces — pieces that do not need each other'"'"'s
output, since workers cannot see each other.
Send each with send_to_agent, including enough context to act alone: a worker
has its own memory and has not seen this conversation.
Collect the replies, reconcile them, and report one answer.
Use remember to record decisions you should not have to make twice."
}'
```

Workers get the other half:

```sh
curl -X POST $URL/agents/w-1/agents-md -d '{"content":
"You do one piece of work at a time and report back.
When you finish, send_to_agent supervisor with your result and anything you
learned that changes the plan. Be specific: they cannot see your work."
}'
```

Then just talk to the supervisor — `POST /agents/supervisor/send`.

**Note:** `send_to_agent` waits for the other agent's reply, so a supervisor
messaging three workers in sequence waits for all three. To fan out without
blocking, post to the route directly with `{"async": true}`, which returns
`{accepted: true}` immediately and lets the worker report back on its own.

## 2. Peer review

Two agents, no hierarchy, different models on purpose — a second model catches
what the first is systematically blind to.

```
   ┌────────┐  send_to_agent   ┌────────┐
   │ author │ ───────────────> │ critic │
   │ pi     │ <─────────────── │ claude │
   └────────┘                  └────────┘
```

```sh
curl -X POST $URL/agents/author/agents-md -d '{"content":
"Draft the work, then send_to_agent critic for review before you answer.
Address what comes back, or say plainly why you disagree. One round only."
}'

curl -X POST $URL/agents/critic/agents-md -d '{"content":
"You review. Be concrete: what is wrong, where, and what would fix it.
If it is sound, say so in one line — do not invent problems to look useful."
}'
```

The depth cap stops this at three hops, so a disagreement cannot ping-pong
forever.

## 3. Pipeline

Each stage does one job and hands off. Nobody coordinates.

```
   research ──> write ──> edit
   (search_web)          (final answer)
```

```sh
curl -X POST $URL/agents/research/agents-md -d '{"content":
"Gather facts with search_web. Do not write prose.
Pass your findings to the write agent with send_to_agent."
}'

curl -X POST $URL/agents/write/agents-md -d '{"content":
"You receive findings and turn them into a draft.
Send the draft to edit with send_to_agent. Do not do your own research."
}'
```

Start it by messaging `research`. The reply surfaces back through the chain,
because each `send_to_agent` returns the next agent's reply — which is also why
a pipeline longer than the depth cap needs `async` sends and a final agent that
reports to whoever asked.

---

## Choosing models per agent

Harnesses bind to the models they can actually drive, so the pairing is checked
at launch rather than failing later:

| Harness | Models | Auth |
|---|---|---|
| `claude-code` | `claude-opus-5` | `CLAUDE_CODE_OAUTH_TOKEN` (a subscription) |
| `pi` | `kimi-k3` | `MOONSHOT_API_KEY` |

A common split is a strong model where judgement matters — planning, review,
reconciling conflicting results — and a cheaper one for work that is mostly
mechanical. Nothing enforces this; it is just where the money goes.

## What this costs

Every `send_to_agent` is a model call on a booted container, so a supervisor
with three workers is four agents' worth of tokens and up to four containers at
$0.038–0.104/hr each. Containers sleep after five idle minutes and bill per
10ms, so the cost is in the work, not in existing. Keep scheduled cadences slow.

Concurrency is capped by `max_instances` in `wrangler.jsonc` — 5 per machine
tier by default. More agents than that will queue for a container rather than
fail, but a fan-out wider than 5 will not all run at once.
