# syntax=docker/dockerfile:1

# The HED engine as an HTTP daemon (server/src/daemon). Build for the platform that runs it:
#
#   docker buildx build --platform linux/amd64 --build-arg HED_LSP_COMMIT=$(git rev-parse --short HEAD) \
#     -t hed-lsp-daemon:local .
#
# Both base images are pinned by the digest of their multi-platform index. Dependabot proposes new
# digests; to look one up by hand: docker buildx imagetools inspect <image>:<tag>

# Build stage: compile the TypeScript, then keep only the production dependencies.
FROM oven/bun:1.4.3-debian@sha256:923bedb355f7746666659f71e724998159a5c8c54bd1cb1030e1975a0698415b AS build
WORKDIR /app

# The manifests first, so the dependency layer is reused until a lockfile or a package.json changes.
COPY package.json bun.lock bunfig.toml ./
COPY client/package.json client/
COPY server/package.json server/
RUN bun install --frozen-lockfile

COPY . .
RUN bun run compile

# Production install of the workspace: the server's dependencies land in server/node_modules, and
# the compiler and test runner do not. The compiled tests and evaluation tools are not needed to
# serve, and neither are the ONNX runtime binaries of other platforms (about 240 MB), because the
# image runs on linux/amd64 only.
RUN rm -rf node_modules client/node_modules server/node_modules server/out/__tests__ server/out/eval \
    && bun install --frozen-lockfile --production \
    && find server/node_modules/onnxruntime-node/bin/napi-v6 -mindepth 2 -maxdepth 2 ! -path '*/linux/x64' -exec rm -rf {} +

# Runtime stage: Node, which the dependencies target, and none of the build tools.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

ARG HED_LSP_COMMIT=unknown
LABEL org.opencontainers.image.title="hed-lsp-daemon" \
      org.opencontainers.image.description="HTTP daemon for HED validation and tag suggestion" \
      org.opencontainers.image.source="https://github.com/hed-standard/hed-lsp" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${HED_LSP_COMMIT}"

# HED_LSP_MODEL_DOWNLOAD=0: a running daemon never downloads the embedding model; seed the cache
# volume once with a run that sets it to 1. dataDir() finds server/data two levels above out/engine,
# which is /app/server/data here.
ENV HED_LSP_COMMIT=${HED_LSP_COMMIT} \
    HOME=/home/node \
    HED_LSP_HOST=0.0.0.0 \
    HED_LSP_PORT=38530 \
    HED_LSP_MODEL_DOWNLOAD=0

WORKDIR /app/server
COPY --from=build /app/server/package.json ./package.json
COPY --from=build /app/server/out ./out
COPY --from=build /app/server/data ./data
COPY --from=build /app/server/node_modules ./node_modules

# The mount point of the model cache volume, owned by the user the daemon runs as.
RUN mkdir -p /home/node/.cache && chown node:node /home/node/.cache

USER node
EXPOSE 38530

# The slim image has no curl, so the probe is part of the daemon.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD ["node", "out/daemon/healthcheck.js"]
CMD ["node", "out/daemon/main.js"]
