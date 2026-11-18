# Standalone API + workflow engine container.
FROM oven/bun:1.4.3 AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY server.ts ./server.ts
COPY server ./server
COPY src/types ./src/types

ENV NODE_ENV=production
ENV FRONTEND_MODE=external
ENV PORT=3000
RUN mkdir -p /app/data && chown -R bun:bun /app
USER bun

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \\
  CMD bun -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "server.ts"]
