# Self-hostable agentinstance sandbox service.
# Includes Node + Python + common CLI tools so agents can actually do work.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Run as a non-root user for a smaller blast radius.
RUN useradd -m sandbox && mkdir -p /workspaces && chown sandbox:sandbox /workspaces
USER sandbox
WORKDIR /app

COPY server.mjs /app/server.mjs

ENV SANDBOX_ROOT=/workspaces \
    PORT=8080
EXPOSE 8080

CMD ["node", "server.mjs"]
