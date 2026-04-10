FROM node:22-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.23.0 --activate

# Build cate-protocol SDK (file: dependency at ../cate-protocol/packages/sdk)
COPY --from=cate-protocol packages/sdk /cate-protocol/packages/sdk
RUN cd /cate-protocol/packages/sdk && npm install --ignore-scripts && npx tsc

WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy source and build
COPY . .
RUN bash scripts/fetch-anthropic-skills.sh && pnpm build

# ── Production image ─────────────────────────────────────────────
FROM node:22-slim AS production

RUN corepack enable && corepack prepare pnpm@10.23.0 --activate

WORKDIR /app

COPY --from=base /cate-protocol /cate-protocol
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Copy built artifacts and runtime files
COPY --from=base /app/dist ./dist
COPY --from=base /app/skills ./skills
COPY --from=base /app/proto ./proto
COPY --from=base /app/src/db/schema.sql ./src/db/schema.sql

# gRPC + WebSocket ports
EXPOSE 8766 8765

ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/index.js"]
CMD ["daemon", "run"]
