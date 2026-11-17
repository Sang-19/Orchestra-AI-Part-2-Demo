import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/database';
import type { User } from '../../src/types/research';

const COOKIE_NAME = 'orchestra_session';
const DEFAULT_DEV_SECRET = 'orchestra-local-dev-signing-secret-change-in-prod';

function getJwtSecret(): string {
  return process.env.JWT_SECRET?.trim() || DEFAULT_DEV_SECRET;
}

export interface AuthenticatedRequest extends Request {
  user?: User;
}

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

export function signAuthToken(user: User): string {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
    },
    getJwtSecret(),
    { expiresIn: '7d' }
  );
}

export function setAuthCookie(res: Response, token: string): void {
  const isHttps = res.req?.secure || res.req?.headers['x-forwarded-proto'] === 'https';
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(isHttps),
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

export function extractTokenFromRequest(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const parts = cookieHeader.split(';');
    for (const part of parts) {
      const [rawKey, ...rest] = part.trim().split('=');
      if (rawKey === COOKIE_NAME) {
        return decodeURIComponent(rest.join('='));
      }
    }
  }
  // Support SSE EventSource auth fallback if needed via query param only when header/cookie absent
  if (typeof req.query.token === 'string' && req.query.token.length > 10) {
    return req.query.token;
  }
  return null;
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const token = extractTokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required. Please sign in.' });
    return;
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret()) as { sub?: string };
    if (!decoded.sub) {
      res.status(401).json({ error: 'Invalid session token.' });
      return;
    }

    const db = getDb();
    const row = db
      .prepare(`SELECT id, email, name, role, created_at FROM users WHERE id = ?`)
      .get(decoded.sub) as
      | { id: string; email: string; name: string; role: string; created_at: string }
      | undefined;

    if (!row) {
      res.status(401).json({ error: 'User account no longer exists.' });
      return;
    }

    req.user = {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      createdAt: row.created_at,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
  }
}

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

export function createRateLimiter(options: { windowMs: number; maxRequests: number; keyPrefix: string }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${options.keyPrefix}:${req.ip || 'unknown'}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    if (bucket.count >= options.maxRequests) {
      res.status(429).json({
        error: 'Rate limit exceeded. Please wait briefly before trying again.',
      });
      return;
    }

    bucket.count += 1;
    next();
  };
}
