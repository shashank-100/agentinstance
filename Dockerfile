# The agent's VM. Cloudflare's base image ships the control server the Sandbox
# SDK talks to; everything below is what an agent needs to do work.
FROM docker.io/cloudflare/sandbox:0.7.0

USER root

# python3 and git: the base image ships neither, and an agent asked to run a
# script or clone a repo fails confusingly without them.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Node 22. The base image ships Node 20, and pi requires >=22.19 — on 20 it
# installs cleanly and then dies with a JS stack trace on every invocation.
# That is the whole "works locally, fails in the container" mystery this
# harness hit twice: a laptop runs a newer Node than the image does.
#
# NodeSource installs to /usr/bin, but the base image keeps its own Node 20 at
# /usr/local/bin, which comes first on PATH — so the upgrade is invisible
# without repointing it. The old binary is kept under a suffix rather than
# deleted: the sandbox control server runs on it, and replacing what it starts
# under is a bigger change than making `node` mean 22.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && mv /usr/local/bin/node /usr/local/bin/node20 \
    && ln -s /usr/bin/node /usr/local/bin/node

# The agent CLIs a harness can run. Each authenticates with its own key, passed
# into the command's environment at run time — never baked into the image.
#
# Versions are pinned because this layer caches: an unpinned install kept an
# 0.74 pi in the image long after 0.84 was current, and the two disagreed about
# what the provider was called (`moonshotai` vs `moonshot`) and which models
# existed. The harness would name a model the CLI had never heard of and fail
# with "Unknown provider". Bump these deliberately.
#
# pi is held at 0.84.0: on 0.86.0 the model is offered no tools at all — it
# answers "no tools have been provided to me" and cannot run bash, so none of
# the capabilities installed onto its PATH are reachable. Same extension, same
# token, same prompt; only the version differs. Re-test tool use before
# raising this.
# One CLI per layer, rather than one `npm install -g` for all three. Together
# they are ~765MB, and a single RUN makes that a single blob: the push sends it
# as one request, so a connection reset at 90% discards the whole thing and the
# retry starts from zero. Split, each pushes independently and a reset costs
# only the layer it interrupted — the rest are already uploaded and skipped.
#
# The order is smallest first, so the layer most likely to survive a flaky link
# is also the one the other two build on.
RUN npm install -g @earendil-works/pi-coding-agent@0.84.0
RUN npm install -g @anthropic-ai/claude-code@2.1.278
RUN npm install -g @openai/codex@0.155.1

# pi-anthropic-oauth makes pi authenticate the way Claude Code does, so an
# ANTHROPIC_OAUTH_TOKEN bills against a Claude subscription instead of API
# credit. Without it pi sends the same token to the plain API and Anthropic
# answers "You're out of extra usage" — the token is valid, the meter is not
# the one the subscription pays for.
#
# Installed into the image, and into the home the CLI actually runs as: pi
# resolves extensions from $HOME/.pi, and a container's filesystem does not
# survive sleeping, so installing at run time would mean reinstalling every
# session.
RUN (id -u agent >/dev/null 2>&1 || useradd -m agent) \
    && runuser -u agent -- env HOME=/home/agent \
         pi install npm:pi-anthropic-oauth \
    && chown -R agent /home/agent

EXPOSE 3000
