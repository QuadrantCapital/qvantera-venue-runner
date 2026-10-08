# syntax=docker/dockerfile:1
FROM node:22-bookworm AS builder
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml .npmrc ./
RUN --mount=type=cache,target=/root/.yarn/berry/cache \
    --mount=type=secret,id=NODE_AUTH_TOKEN \
  export NODE_AUTH_TOKEN="$(cat /run/secrets/NODE_AUTH_TOKEN 2>/dev/null || true)" \
  && yarn install --immutable
COPY tsconfig.json ./
COPY src ./src
RUN --mount=type=cache,target=/root/.yarn/berry/cache \
    --mount=type=secret,id=NODE_AUTH_TOKEN \
  export NODE_AUTH_TOKEN="$(cat /run/secrets/NODE_AUTH_TOKEN 2>/dev/null || true)" \
  && yarn build \
  && rm -rf dist/*.test.* \
  && yarn workspaces focus --production

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
# Build identity, last so a new commit rebuilds only these layers. CI passes the three args; the
# labels let a deploy read the commit and tree from the digest without running it, and the runner
# reports the same two on /health and /metrics.
ARG QV_BUILD_SHA=
ARG QV_BUILD_TREE=
ARG QV_BUILD_TIME=
LABEL org.opencontainers.image.revision="${QV_BUILD_SHA}" \
      org.opencontainers.image.created="${QV_BUILD_TIME}" \
      org.opencontainers.image.source="https://github.com/QuadrantCapital/qvantera-venue-runner" \
      dev.qvantera.build.tree="${QV_BUILD_TREE}"
ENV QV_BUILD_SHA=${QV_BUILD_SHA} QV_BUILD_TREE=${QV_BUILD_TREE} QV_BUILD_TIME=${QV_BUILD_TIME}
USER node
# Exec form: node is PID 1 and receives SIGTERM itself.
CMD ["node", "dist/index.js"]
