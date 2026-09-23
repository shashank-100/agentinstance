# Roadmap

## The bet

Agents that keep working when you are not there, with nothing of yours running.
Cloud-native, always-on, doing real work. The competitors are local-first — their
agents stop when the laptop closes, and reaching them from a phone is most of
their codebase. That problem is one this does not have.

## Now — the loop that exists, working properly

**1. A supervisor for failures.**
A task requeues when its agent dies and nobody is told. One agent hears about a
broken run and decides: retry, reassign, or say a person is needed. Hard limits
so a crash loop is one incident rather than a storm. Every primitive for it is
already here — `send_to_agent`, alarms, the board.

**2. Test pi end to end.**
The catalog reports it ready and no pull request has ever come from it. Either
it works or it does not; today that is a guess.

*Done when: file five tasks, close the laptop, come back to five pull requests.*

## Next — work arrives by itself

**3. GitHub Issues to task.**
Label an issue and a task appears. The highest-leverage item here: the same
GitHub App is already installed, agents already push to the same repositories,
and it closes the loop — issue in, pull request out, nobody dispatching by hand.

**4. Slack or email out.**
"A pull request is ready" reaches someone without opening the cockpit.

## Then — a browser the agent can use

**5. Browser sessions.**
`browse_page` only reads: one URL, rendered to markdown, no state. A real
browser is open / click / type / screenshot with the session persisting between
calls, the way the checkout already does. Cloudflare's Browser Rendering
supports it and the binding is already bound.

This is the answer to desktop control that fits the architecture — nothing runs
on anyone's machine. It needs vision, since an agent has to see a page to click
it, and that is a day's work rather than an hour's.

## Later

- **MCP.** The standard way to add tools, worth it once agents do work beyond
  code. Note that OpenMausBot's bridge spawns child processes over stdio, so it
  does not port to Workers — remote HTTP servers are the shape that would.
- **A second model.** The local OpenAI-compatible provider is wired and switched
  off. Until it is on, everything depends on one Claude subscription.
- **Permission levels.** Agents run with everything enabled and no dial.

## Never

Desktop control, mobile apps, voice, a connector platform. That is the
everywhere-and-everything bet, and it needs a desktop app, mobile apps and an
integrations team to pay off. Chasing it means being a worse version of someone
else rather than the only version of this.
