# Build from the repo root: docker build -f packages/pi-knight/Dockerfile .
FROM node:22.19-slim AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/pi-knight/package.json ./packages/pi-knight/
RUN npm ci --workspace packages/pi-knight --workspace packages/core --include-workspace-root
COPY packages/core/tsconfig.json ./packages/core/
COPY packages/core/src/ ./packages/core/src/
COPY packages/pi-knight/tsconfig.json ./packages/pi-knight/
COPY packages/pi-knight/src/ ./packages/pi-knight/src/
RUN npm run build --workspace packages/core --workspace packages/pi-knight
RUN npm ci --omit=dev --workspace packages/pi-knight --workspace packages/core --include-workspace-root
# Flatten into the layout the runtime stage expects: nested workspace deps
# (kept out of the hoisted root by version conflicts) are merged over the root
# node_modules, and the dangling workspace symlinks are dropped. The shared core is installed as a real
# package so a later dependency on @roundtable/knight-core resolves at runtime.
RUN mkdir -p /out \
    && cp -a node_modules /out/node_modules \
    && if [ -d packages/pi-knight/node_modules ]; then cp -a packages/pi-knight/node_modules/. /out/node_modules/; fi \
    && rm -rf /out/node_modules/pi-knight /out/node_modules/@roundtable/knight-core \
    && mkdir -p /out/node_modules/@roundtable/knight-core \
    && cp -a packages/core/package.json packages/core/dist /out/node_modules/@roundtable/knight-core/

FROM node:22.19-slim
LABEL org.opencontainers.image.source="https://github.com/roundtable-k8s/knights" \
      org.opencontainers.image.description="pi-knight: universal base agent runtime for the Knights of the Round Table" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app

# System packages — minimal base
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    && rm -rf /var/lib/apt/lists/*

# ── Mise (baseline tools) ────────────────────────────────────────
# renovate: datasource=github-releases depName=jdx/mise
ARG MISE_VERSION=v2026.11.6
RUN curl -fsSL https://mise.run | MISE_VERSION=${MISE_VERSION} MISE_INSTALL_PATH=/usr/local/bin/mise sh
COPY packages/pi-knight/mise.toml /app/mise.toml
ENV MISE_DATA_DIR=/app/.mise \
    MISE_CONFIG_FILE=/app/mise.toml \
    MISE_YES=1
RUN mise install --cd /app && mise reshim

# ── agent-browser CLI (token-efficient browser automation) ────────
ARG AGENT_BROWSER_VERSION=0.43.0
RUN npm install -g agent-browser@${AGENT_BROWSER_VERSION}

# ── App code ──────────────────────────────────────────────────────
COPY --from=builder /app/packages/pi-knight/dist ./dist
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /app/packages/pi-knight/package.json ./
COPY packages/pi-knight/defaults/ ./defaults/
COPY packages/pi-knight/scripts/ ./scripts/
# Shared start-up scripts (identical for both runtimes).
COPY packages/core/scripts/startup-signals.sh ./scripts/startup-signals.sh
COPY packages/core/scripts/early-signals.mjs ./scripts/early-signals.mjs
# GitHub token-file support (roundtable-k8s/roundtable#194): a git credential
# helper and a gh shim that read $GITHUB_TOKEN_FILE on every call. The
# entrypoint puts /opt/roundtable/bin first on PATH when that file is set.
RUN install -D -m 0755 scripts/github/git-credential-roundtable /usr/local/bin/git-credential-roundtable \
    && install -D -m 0755 scripts/github/gh /opt/roundtable/bin/gh

# ── Runtime ───────────────────────────────────────────────────────
# Baseline tools live in /app/.mise; the writable data dir is /data/.mise.
# Shared install dirs let mise find the baked tools without any network.
ENV MISE_DATA_DIR=/data/.mise \
    MISE_SHARED_INSTALL_DIRS=/app/.mise/installs \
    MISE_YES=1

# Smoke check: baseline shims resolve offline from an empty data dir (shims, not
# `mise exec`, which falls back to same-named binaries on the system PATH).
RUN MISE_OFFLINE=1 MISE_DATA_DIR=/tmp/empty-mise MISE_CONFIG_FILE=/app/mise.toml sh -c 'for t in rg python yq; do /app/.mise/shims/$t --version || exit 1; done'

# Smoke check: runtime dependencies resolve (a dev-only import fails the build).
RUN node --input-type=module -e "await import('@roundtable/knight-core'); await import('@earendil-works/pi-coding-agent'); await import('@opentelemetry/api')"

# Non-root
USER node

EXPOSE 3000
CMD ["/app/scripts/entrypoint.sh"]
