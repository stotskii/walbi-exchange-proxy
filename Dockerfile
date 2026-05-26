# Single-stage build — runtime is small enough that multi-stage isn't worth it
FROM node:22-alpine AS build

WORKDIR /app

# install pnpm
RUN corepack enable

COPY package.json ./
COPY pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# Runtime image — keep deps but drop the source/tsx
FROM node:22-alpine
WORKDIR /app
RUN corepack enable

COPY package.json ./
COPY pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod || pnpm install --prod

COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=3002
EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3002/healthz || exit 1

CMD ["node", "dist/server.js"]
