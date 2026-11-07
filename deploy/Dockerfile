# API and web images. Build context is the repo root.
#   docker build -f deploy/Dockerfile --target api .
#   docker build -f deploy/Dockerfile --target web .
FROM node:22-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile

# The api and worker run TypeScript directly through tsx (their `start` scripts), so the deps
# stage is the runtime image.
FROM deps AS api
ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@wma/api", "start"]

FROM deps AS web-build
RUN pnpm --filter @wma/web build

FROM caddy:2-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/apps/web/dist /srv
