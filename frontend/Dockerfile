# Standalone Vite frontend with hot-module replacement for local development.
FROM oven/bun:1.4.3 AS frontend
WORKDIR /app

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
