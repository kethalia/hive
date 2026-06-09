ARG PNPM_VERSION=10.32.1
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:20-alpine

FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY packages/auth/package.json packages/auth/package.json
COPY packages/db/package.json packages/db/package.json
COPY services/auth/package.json services/auth/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM ${NODE_IMAGE} AS deploy
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/auth/node_modules ./packages/auth/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/services/auth/node_modules ./services/auth/node_modules
COPY packages/auth/ packages/auth/
COPY packages/db/ packages/db/
COPY services/auth/ services/auth/
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
# Generate the @hive/db Prisma client before deploy so the deployed
# workspace copy carries it. The `pnpm deploy --ignore-scripts` below
# preserves --ignore-scripts for security; client generation only runs
# here, in the build stage.
RUN pnpm --filter @hive/db db:generate
RUN pnpm deploy --filter hive-auth --prod --legacy --ignore-scripts /deploy

FROM ${NODE_IMAGE} AS runner
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production
ENV BIND_HOST=0.0.0.0
RUN addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 appuser -G appgroup
COPY --from=deploy --chown=appuser:appgroup /deploy ./
USER appuser
EXPOSE 4400
ENTRYPOINT ["tini", "--"]
CMD ["node", "--import", "tsx", "src/index.ts"]
