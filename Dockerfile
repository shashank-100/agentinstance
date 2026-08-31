# The agent's VM. Cloudflare's base image ships the control server the Sandbox
# SDK talks to; everything below is what an agent needs to do work.
FROM docker.io/cloudflare/sandbox:0.7.0

USER root

# python3 and git: the base image ships neither, and an agent asked to run a
# script or clone a repo fails confusingly without them.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv git \
    && rm -rf /var/lib/apt/lists/*

# The agent CLIs a harness can run. Each authenticates with its own key, passed
# into the command's environment at run time — never baked into the image.
RUN npm install -g @anthropic-ai/claude-code @earendil-works/pi-coding-agent

EXPOSE 3000
