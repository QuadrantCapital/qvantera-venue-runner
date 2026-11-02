# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM node:24-bookworm@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413 AS builder
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

FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
WORKDIR /app
COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
# The install files travel with the image they install: `docker run --rm --entrypoint cat <image>
# /app/install/compose.yaml` gives the compose file of exactly this release (qvantera-deploy's e2e
# installs its second runner that way).
COPY compose.yaml .env.example install.sh /app/install/
# Build identity, last so a new commit rebuilds only these layers (M-500). CI passes the three args.
# The labels let a deploy read the commit and tree from the digest without running it; the file is
# what the runner reports on /health, /metrics and its startup line — baked in, so no configuration
# can claim a build the image is not.
ARG QV_BUILD_SHA=
ARG QV_BUILD_TREE=
ARG QV_BUILD_TIME=
LABEL org.opencontainers.image.revision="${QV_BUILD_SHA}" \
      org.opencontainers.image.created="${QV_BUILD_TIME}" \
      org.opencontainers.image.source="https://github.com/QuadrantCapital/qvantera-venue-runner" \
      dev.qvantera.build.tree="${QV_BUILD_TREE}"
RUN printf '{"sha":"%s","tree":"%s","time":"%s"}\n' "${QV_BUILD_SHA}" "${QV_BUILD_TREE}" "${QV_BUILD_TIME}" > /build-info.json
USER node
# Exec form: node is PID 1 and receives SIGTERM itself.
CMD ["node", "dist/index.js"]
