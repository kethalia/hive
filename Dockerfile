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
COPY services/terminal-proxy/package.json services/terminal-proxy/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM ${NODE_IMAGE} AS builder
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/auth/node_modules ./packages/auth/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/services/auth/node_modules ./services/auth/node_modules
COPY --from=deps /app/services/terminal-proxy/node_modules ./services/terminal-proxy/node_modules
COPY . .
RUN pnpm --filter @hive/db db:generate
RUN pnpm build

FROM ${NODE_IMAGE} AS runner
ARG CODER_VERSION=2.33.0
ARG TARGETARCH
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
RUN apk add --no-cache ca-certificates curl openssh-client && \
    curl -fsSL https://coder.com/install.sh | sh && \
    coder version && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    mkdir -p /home/coder && \
    chown nextjs:nodejs /home/coder
RUN apk add --no-cache ca-certificates curl tar && \
    case "${TARGETARCH:-amd64}" in \
      amd64) coder_arch="amd64"; coder_sha="0089d46a9931498e5dcbe6df6bfb7153a2345156b5e7388ccbce8fb9b430061a" ;; \
      arm64) coder_arch="arm64"; coder_sha="c66893c330bb5a3fdbd046965f36426d1be91969e6edecd27c31a21cb51aeb50" ;; \
      *) echo "Unsupported Coder CLI architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/coder/coder/releases/download/v${CODER_VERSION}/coder_${CODER_VERSION}_linux_${coder_arch}.tar.gz" -o /tmp/coder.tar.gz && \
    echo "${coder_sha}  /tmp/coder.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/coder.tar.gz -C /usr/local/bin ./coder && \
    chmod 0755 /usr/local/bin/coder && \
    rm /tmp/coder.tar.gz
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
