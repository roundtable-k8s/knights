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
WORKDIR /app

# System packages — minimal base
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# ── Cache Nix installer tarball (avoids download on every fresh PVC) ──
# We DON'T install Nix into the image — it lives entirely on the PVC.
# This just caches the ~20MB tarball so first boot is faster.
ARG NIX_VERSION=2.28.3
RUN curl -L "https://releases.nixos.org/nix/nix-${NIX_VERSION}/nix-${NIX_VERSION}-x86_64-linux.tar.xz" \
      -o /tmp/nix-installer.tar.xz \
    && mkdir -p /opt/nix-cache \
    && mv /tmp/nix-installer.tar.xz /opt/nix-cache/

# ── Mise (baseline tools) ────────────────────────────────────────
RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh
COPY packages/pi-knight/mise.toml /app/mise.toml
ENV MISE_DATA_DIR=/app/.mise \
    MISE_CONFIG_FILE=/app/mise.toml \
    MISE_YES=1
RUN mise install --cd /app && mise reshim

# ── agent-browser CLI (token-efficient browser automation) ────────
RUN npm install -g agent-browser 2>/dev/null || true

# ── App code ──────────────────────────────────────────────────────
COPY --from=builder /app/packages/pi-knight/dist ./dist
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /app/packages/pi-knight/package.json ./
COPY packages/pi-knight/defaults/ ./defaults/
COPY packages/pi-knight/scripts/ ./scripts/
# GitHub token-file support (roundtable-k8s/roundtable#194): a git credential
# helper and a gh shim that read $GITHUB_TOKEN_FILE on every call. The
# entrypoint puts /opt/roundtable/bin first on PATH when that file is set.
RUN install -D -m 0755 scripts/github/git-credential-roundtable /usr/local/bin/git-credential-roundtable \
    && install -D -m 0755 scripts/github/gh /opt/roundtable/bin/gh

# ── Runtime ───────────────────────────────────────────────────────
ENV MISE_DATA_DIR=/data/.mise \
    MISE_YES=1

# Non-root
USER node

EXPOSE 3000
CMD ["/app/scripts/entrypoint.sh"]
