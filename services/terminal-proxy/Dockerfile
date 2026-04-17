ARG PNPM_VERSION=10.32.1

FROM node:20-alpine AS deps
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY services/terminal-proxy/package.json services/terminal-proxy/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM node:20-alpine AS deploy
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/services/terminal-proxy/node_modules ./services/terminal-proxy/node_modules
COPY services/terminal-proxy/ services/terminal-proxy/
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm deploy --filter hive-terminal-proxy --prod --legacy /deploy

FROM node:20-alpine AS runner
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production
ENV BIND_HOST=0.0.0.0
RUN addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 appuser -G appgroup
COPY --from=deploy --chown=appuser:appgroup /deploy ./
USER appuser
EXPOSE 3001
ENTRYPOINT ["tini", "--"]
CMD ["node", "--import", "tsx", "src/index.ts"]
