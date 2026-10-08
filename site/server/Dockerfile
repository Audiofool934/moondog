# Moondog's public agent. Build from the repository root:
#   docker build -f site/server/Dockerfile -t moondog-agent .
FROM node:24-slim

# Moondog lists and reads Spotify ZIPs with the system unzip.
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY assets/brand ./assets/brand
COPY contracts ./contracts
COPY scripts ./scripts
COPY src ./src
COPY site/room/fictional-history.mjs ./site/room/fictional-history.mjs
COPY site/server/agent-server.mjs site/server/limits.mjs ./site/server/

# The day's spending is saved here; mount a volume so it survives restarts.
RUN mkdir -p /var/lib/moondog-agent && chown node:node /var/lib/moondog-agent
ENV NODE_ENV=production PORT=8787 MOONDOG_AGENT_STATE_DIR=/var/lib/moondog-agent
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "site/server/agent-server.mjs"]
