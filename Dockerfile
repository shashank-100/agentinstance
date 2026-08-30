# Container image for the agent sandbox. The Cloudflare base image ships the
# control server the Sandbox SDK talks to; everything below is what agents need
# to actually do work.
FROM docker.io/cloudflare/sandbox:0.7.0

USER root

# Python and git: the base image ships neither, and an agent asked to "run this
# script" or "clone that repo" fails confusingly without them.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv git \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 3000
