FROM node:22.19-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev \
    && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl

FROM node:22.19-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    procps \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# ── Nix installer cache (Nix itself lives on the PVC; see scripts/nix-lib.sh) ──
ARG NIX_VERSION=2.28.3
RUN curl -L "https://releases.nixos.org/nix/nix-${NIX_VERSION}/nix-${NIX_VERSION}-x86_64-linux.tar.xz" \
      -o /tmp/nix-installer.tar.xz \
    && mkdir -p /opt/nix-cache \
    && mv /tmp/nix-installer.tar.xz /opt/nix-cache/

# ── Mise baseline tools (python, yq, ripgrep for skill scripts) ──
RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh
COPY mise.toml /app/mise.toml
ENV MISE_DATA_DIR=/app/.mise \
    MISE_CONFIG_FILE=/app/mise.toml \
    MISE_YES=1
RUN mise install --cd /app && mise reshim

# ── agent-browser CLI for the browser sidecar (spec.capabilities.browser) ──
ARG AGENT_BROWSER_VERSION=0.43.0
RUN npm install -g agent-browser@${AGENT_BROWSER_VERSION}

# ── App ──
# node_modules carries the Agent SDK and its platform package with the native
# Claude Code binary (@anthropic-ai/claude-agent-sdk-linux-x64).
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY defaults/ ./defaults/
COPY scripts/ ./scripts/

ENV NODE_ENV=production \
    MISE_DATA_DIR=/data/.mise \
    MISE_YES=1 \
    CLAUDE_CONFIG_DIR=/data/.claude-home \
    DISABLE_AUTOUPDATER=1

# Non-root: Claude Code refuses bypassPermissions as root.
USER node

EXPOSE 3000
CMD ["/app/scripts/entrypoint.sh"]
