# Build from the repo root: docker build -f packages/claude-knight/Dockerfile .
FROM node:22.19-slim AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/claude-knight/package.json ./packages/claude-knight/
RUN npm ci --workspace packages/claude-knight --workspace packages/core --include-workspace-root
COPY packages/core/tsconfig.json ./packages/core/
COPY packages/core/src/ ./packages/core/src/
COPY packages/claude-knight/tsconfig.json ./packages/claude-knight/
COPY packages/claude-knight/src/ ./packages/claude-knight/src/
RUN npm run build --workspace packages/core --workspace packages/claude-knight
RUN npm ci --omit=dev --workspace packages/claude-knight --workspace packages/core --include-workspace-root \
    && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl \
       packages/claude-knight/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl
# Flatten into the layout the runtime stage expects: nested workspace deps
# (kept out of the hoisted root by version conflicts) are merged over the root
# node_modules, and the dangling workspace symlinks are dropped. The shared core is installed as a real
# package so a later dependency on @roundtable/knight-core resolves at runtime.
RUN mkdir -p /out \
    && cp -a node_modules /out/node_modules \
    && if [ -d packages/claude-knight/node_modules ]; then cp -a packages/claude-knight/node_modules/. /out/node_modules/; fi \
    && rm -rf /out/node_modules/claude-knight /out/node_modules/@roundtable/knight-core \
    && mkdir -p /out/node_modules/@roundtable/knight-core \
    && cp -a packages/core/package.json packages/core/dist /out/node_modules/@roundtable/knight-core/

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
COPY packages/claude-knight/mise.toml /app/mise.toml
ENV MISE_DATA_DIR=/app/.mise \
    MISE_CONFIG_FILE=/app/mise.toml \
    MISE_YES=1
RUN mise install --cd /app && mise reshim

# ── agent-browser CLI for the browser sidecar (spec.capabilities.browser) ──
ARG AGENT_BROWSER_VERSION=0.43.0
RUN npm install -g agent-browser@${AGENT_BROWSER_VERSION}

# ── GitHub token file (roundtable-k8s/roundtable#194) ──
# A git credential helper and a gh shim that read $GITHUB_TOKEN_FILE on every
# call. The entrypoint puts /opt/roundtable/bin first on PATH when it is set.
COPY packages/claude-knight/scripts/github/git-credential-roundtable /usr/local/bin/git-credential-roundtable
COPY packages/claude-knight/scripts/github/gh /opt/roundtable/bin/gh

# ── App ──
# node_modules carries the Agent SDK and its platform package with the native
# Claude Code binary (@anthropic-ai/claude-agent-sdk-linux-x64).
COPY --from=builder /app/packages/claude-knight/dist ./dist
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /app/packages/claude-knight/package.json ./
COPY packages/claude-knight/defaults/ ./defaults/
COPY packages/claude-knight/scripts/ ./scripts/

# ── Claude Code CLI (`claude` on PATH, for CLAUDE_RUNTIME=cli) ──
# Pinned. The Agent SDK's platform package ships the official Claude Code
# native binary, byte-identical to @anthropic-ai/claude-code-linux-x64 of the
# same version (SDK 0.3.N bundles CLI 2.1.N). When CLAUDE_CODE_VERSION matches
# the SDK's bundled CLI, `claude` links to that binary instead of shipping a
# second ~360 MB copy; otherwise the pinned CLI is installed on its own. Either
# way the build fails unless `claude --version` reports the pinned version.
# renovate: datasource=npm depName=@anthropic-ai/claude-code
ARG CLAUDE_CODE_VERSION=2.1.329
RUN set -eu; \
    sdk_cli="$(jq -r .claudeCodeVersion node_modules/@anthropic-ai/claude-agent-sdk/package.json)"; \
    sdk_bin=/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude; \
    if [ "$sdk_cli" = "$CLAUDE_CODE_VERSION" ] && [ -x "$sdk_bin" ]; then \
      ln -s "$sdk_bin" /usr/local/bin/claude; \
      echo "claude: reusing the Agent SDK's bundled CLI $sdk_cli"; \
    else \
      tmp="$(mktemp -d)"; cd "$tmp"; \
      npm pack --silent "@anthropic-ai/claude-code-linux-x64@${CLAUDE_CODE_VERSION}"; \
      tar xzf ./*.tgz; \
      install -D -m 0755 package/claude /opt/claude-code/claude; \
      ln -s /opt/claude-code/claude /usr/local/bin/claude; \
      cd /; rm -rf "$tmp" /root/.npm; \
      echo "claude: installed CLI ${CLAUDE_CODE_VERSION} (SDK bundles ${sdk_cli})"; \
    fi; \
    claude --version | grep -q "^${CLAUDE_CODE_VERSION} "

ENV MISE_DATA_DIR=/data/.mise \
    MISE_YES=1 \
    CLAUDE_CONFIG_DIR=/data/.claude-home \
    DISABLE_AUTOUPDATER=1

# Non-root: Claude Code refuses bypassPermissions as root.
USER node

EXPOSE 3000
CMD ["/app/scripts/entrypoint.sh"]
