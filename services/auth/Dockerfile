ARG PNPM_VERSION=10.32.1

FROM node:20-alpine AS deps
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY packages/auth/package.json packages/auth/package.json
COPY services/auth/package.json services/auth/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM node:20-alpine AS deploy
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/auth/node_modules ./packages/auth/node_modules
COPY --from=deps /app/services/auth/node_modules ./services/auth/node_modules
COPY packages/auth/ packages/auth/
COPY services/auth/ services/auth/
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN cd services/auth && npx prisma generate
RUN pnpm deploy --filter hive-auth --prod --legacy --ignore-scripts /deploy

FROM node:20-alpine AS runner
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
