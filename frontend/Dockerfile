# Standalone Vite frontend with hot-module replacement for local development.
FROM oven/bun:1.4.3 AS frontend
WORKDIR /app

# The shared lockfile includes better-sqlite3. Bun may run its native
# node-gyp install script even in the frontend image, so provide the
# Python and compiler toolchain required to build native dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY index.html ./index.html
COPY vite.config.ts ./vite.config.ts
COPY tsconfig.json ./tsconfig.json
COPY src ./src

ENV NODE_ENV=development
ENV VITE_API_PROXY_TARGET=http://backend:3000
EXPOSE 5173

CMD ["bun", "run", "dev:frontend"]
