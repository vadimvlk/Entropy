# syntax=docker/dockerfile:1

# ---------- build: client bundle (dist/) + self-contained server (dist-server/) ----------
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# tsc + vite → dist/ ; esbuild bundles the server (+ shared core) → dist-server/index.mjs
RUN npm run build && npm run build:server

# ---------- runtime: tiny image, no node_modules ----------
# The server is a single bundled .mjs that uses only Node built-ins (node:http,
# node:sqlite, node:crypto, …), so nothing needs installing at runtime.
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/market.db

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server

# SQLite lives on a volume so the 24/7 stream survives container re-creation.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8787
VOLUME ["/data"]

# Liveness: the data plane must answer (Node 24 has global fetch).
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/index.mjs"]
