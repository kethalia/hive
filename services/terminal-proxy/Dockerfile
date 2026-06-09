ARG PNPM_VERSION=10.32.1
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:20-alpine

FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY packages/auth/package.json packages/auth/package.json
COPY packages/db/package.json packages/db/package.json
COPY services/terminal-proxy/package.json services/terminal-proxy/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM ${NODE_IMAGE} AS deploy
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/auth/node_modules ./packages/auth/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/services/terminal-proxy/node_modules ./services/terminal-proxy/node_modules
COPY packages/auth/ packages/auth/
COPY packages/db/ packages/db/
COPY services/terminal-proxy/ services/terminal-proxy/
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm deploy --filter hive-terminal --prod --legacy --ignore-scripts /deploy

FROM ${NODE_IMAGE} AS runner
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production
ENV BIND_HOST=0.0.0.0
RUN addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 appuser -G appgroup && \
    mkdir -p /home/coder && \
    chown appuser:appgroup /home/coder
COPY --from=deploy --chown=appuser:appgroup /deploy ./
USER appuser
EXPOSE 3001
ENTRYPOINT ["tini", "--"]
CMD ["node", "--import", "tsx", "src/index.ts"]
