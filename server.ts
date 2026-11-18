import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';
import { closeDb, getDb } from './server/db/database';
import { createApiRouter } from './server/routes/api';

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

async function startServer() {
  console.log('[BOOT 1/5] Initializing Orchestra AI backend...');
  console.log(`[BOOT] Runtime: ${isProduction ? 'production' : 'development'} | Port: ${PORT}`);

  console.log('[BOOT 2/5] Connecting to SQLite and initializing schema...');
  const db = getDb();
  db.prepare('SELECT 1').get();
  console.log('[OK] Database connected; schema check passed.');

  const app = express();
  app.set('trust proxy', 1);

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('CORS origin not allowed'));
        }
      },
      credentials: true,
    })
  );

  // Log request outcomes without logging request bodies, credentials, or query strings.
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const label = req.path.startsWith('/api') ? 'API' : 'FRONTEND';
      const status = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'OK';
      console.log(`[${label}][${status}] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
    });
    next();
  });

  // Basic security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use(express.json({ limit: '2mb' }));

  console.log('[BOOT 3/5] Registering backend API routes...');
  app.use('/api', createApiRouter());
  console.log('[OK] API routes registered. Health endpoint: /api/health');

  if (!isProduction) {
    console.log('[BOOT 4/5] Starting Vite development frontend middleware...');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.log('[OK] Vite frontend middleware ready.');
  } else {
    console.log('[BOOT 4/5] Checking and mounting production frontend build...');
    const distDir = path.resolve(process.cwd(), 'dist');
    const indexHtml = path.join(distDir, 'index.html');
    if (!fs.existsSync(indexHtml)) {
      throw new Error(`Frontend build missing: ${indexHtml}. Run the production build first.`);
    }
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(indexHtml);
    });
    console.log('[OK] Production frontend build found and mounted.');
  }

  console.log('[BOOT 5/5] Starting HTTP server...');
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('==================================================');
    console.log('[READY] Orchestra AI backend is listening.');
    console.log(`[READY] Frontend: http://localhost:${PORT}`);
    console.log(`[READY] API health: http://localhost:${PORT}/api/health`);
    console.log('[READY] Request logs enabled (API + frontend).');
    console.log('==================================================');
  });

  const shutdown = () => {
    console.log('[SHUTDOWN] Closing HTTP server and database...');
    server.close(() => {
      closeDb();
      console.log('[SHUTDOWN] Clean shutdown complete.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startServer().catch((err) => {
  console.error('[FATAL] Orchestra AI startup failed:', err);
  process.exit(1);
});
