# Container image for the agent sandbox. The Cloudflare base image ships the
# control server the Sandbox SDK talks to; add tools agents need on top.
FROM docker.io/cloudflare/sandbox:0.7.0
EXPOSE 3000
