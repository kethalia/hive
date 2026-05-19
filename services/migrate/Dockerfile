# Dedicated Prisma migrate image.
#
# Built from the @hive/db workspace package which owns the schema and
# migrations. Runs `prisma migrate deploy` against DATABASE_URL and exits.
# Invoked by charts/hive/templates/migrate-job.yaml as a Helm hook.
ARG PNPM_VERSION=10.32.1

FROM node:20-alpine AS deps
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY packages/db/package.json packages/db/package.json
COPY services/migrate/package.json services/migrate/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM node:20-alpine AS deploy
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY packages/db/ packages/db/
COPY services/migrate/ services/migrate/
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
# Generate the Prisma client so the deployed copy carries it. Migrate
# itself doesn't need the generated client, but the postinstall in
# @hive/db expects it and downstream tooling does.
RUN pnpm --filter @hive/db db:generate
# Note: --ignore-scripts is intentionally NOT passed here. The migrate
# image runs only our own workspace packages (@hive/db + hive-migrate);
# their postinstall is prisma generate, which we explicitly want, and
# pnpm needs lifecycle to wire `node_modules/.bin/prisma` reliably.
RUN pnpm deploy --filter hive-migrate --prod --legacy /deploy

FROM node:20-alpine AS runner
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 appuser -G appgroup
COPY --from=deploy --chown=appuser:appgroup /deploy ./
USER appuser
ENTRYPOINT ["tini", "--"]
CMD ["node_modules/.bin/prisma", "migrate", "deploy", "--schema", "node_modules/@hive/db/prisma/schema.prisma"]
