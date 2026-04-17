FROM node:20-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY services/terminal-proxy/package.json services/terminal-proxy/package.json
COPY prisma/ prisma/
RUN pnpm install --frozen-lockfile

FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/services/terminal-proxy/node_modules ./services/terminal-proxy/node_modules
COPY . .
RUN pnpm build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
