# ---------------------------------------------------------------------------
# Ghost Bazaar Engine — Multi-stage Docker build
#
# Uses `pnpm deploy` to create a standalone production bundle with all
# workspace dependencies resolved and flattened into a single directory.
# ---------------------------------------------------------------------------

FROM node:22-slim AS base
RUN corepack enable

# --- Build: install deps + compile TypeScript ---
FROM base AS build
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ghost-bazaar/core build && \
    pnpm --filter @ghost-bazaar/strategy build && \
    pnpm --filter @ghost-bazaar/zk build && \
    pnpm --filter @ghost-bazaar/settlement build && \
    pnpm --filter @ghost-bazaar/agents build && \
    pnpm --filter @ghost-bazaar/engine build

# pnpm deploy bundles the package + all prod workspace deps into /deploy
RUN pnpm --filter @ghost-bazaar/engine deploy --prod --legacy /deploy

# --- Production: minimal runtime image ---
FROM base
WORKDIR /app

COPY --from=build /deploy .

EXPOSE 3000
ENV NODE_ENV=production

CMD ["node", "dist/server.js"]
