import { type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { getUserById, getSetting, setSetting } from './db.js';

// Extend Express Request with auth properties so middleware and handlers can
// access req.authUser / req.webhookAuthenticated without unsafe casts.
declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
      webhookAuthenticated?: boolean;
    }
  }
}

let JWT_SECRET: string;

/** Load the JWT secret from the Docker secret file or environment.
 *  Exported so tests can validate the loading logic in isolation. */
export function loadJwtSecret(secretPath?: string, envValue?: string): string {
  const secretFile = secretPath ?? '/run/secrets/jwt_secret';
  try {
    return fs.readFileSync(secretFile, 'utf8').trim();
  } catch {
    return envValue ?? process.env.JWT_SECRET ?? '';
  }
}

JWT_SECRET = loadJwtSecret();
if (!JWT_SECRET) {
  console.error(`FATAL: JWT secret not found at /run/secrets/jwt_secret or in JWT_SECRET env var.`);
  process.exit(1);
}
const JWT_EXPIRES_IN = '7d';

/** Load the webhook secret for CI/CD-triggered endpoints.
 *  Priority: DB setting → file → env → auto-generate.
 *  Exported so tests can validate the loading logic in isolation. */
export function loadWebhookSecret(secretPath?: string, envValue?: string): string {
  // 1. DB setting (set by auto-gen on first start or manual rotate).
  const dbSecret = getSetting('webhook_secret');
  if (dbSecret) return dbSecret;

  // 2. Docker secret file.
  const secretFile = secretPath ?? '/run/secrets/github_webhook_secret';
  try {
    const fileSecret = fs.readFileSync(secretFile, 'utf8').trim();
    if (fileSecret) {
      setSetting('webhook_secret', fileSecret);
      return fileSecret;
    }
  } catch { /* no file */ }

  // 3. Environment variable.
  const envSecret = envValue ?? process.env.GITHUB_WEBHOOK_SECRET ?? '';
  if (envSecret) {
    setSetting('webhook_secret', envSecret);
    return envSecret;
  }

  // 4. Auto-generate and persist.
  const generated = randomBytes(32).toString('base64url');
  setSetting('webhook_secret', generated);
  return generated;
}

/** Return the current webhook secret (or empty string if not configured). */
export function getWebhookSecret(): string {
  return getSetting('webhook_secret') || '';
}

/** Generate a new webhook secret, replacing the old one. */
export function rotateWebhookSecret(): string {
  const generated = randomBytes(32).toString('base64url');
  setSetting('webhook_secret', generated);
  return generated;
}

// Ensure webhook secret is loaded into DB on startup (side-effect only —
// webhookAuth middleware reads the live DB value via getWebhookSecret()).
// Safe to skip if DB isn't initialized yet (e.g. during tests that init later).
try { loadWebhookSecret(); } catch { /* DB not ready yet — will run on first request */ }

export interface AuthUser {
  userId: string;
  email: string;
}

/** Sign a JWT for the given user. */
export function signToken(user: { id: string; email: string }): string {
  return jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET!, { expiresIn: JWT_EXPIRES_IN });
}

/** Express middleware: extracts and verifies the Authorization Bearer token,
 *  populating req.authUser. Returns 401 if absent, expired, or invalid. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  // The browser's native EventSource API cannot set request headers, so SSE
  // endpoints (e.g. /api/notifications/stream) accept the token via a
  // `?token=` query parameter as a fallback for authenticated clients.
  const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : queryToken;
  if (!token) {
    res.status(401).json({ error: 'Authorization header required.' });
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET!) as unknown as AuthUser;
    const user = getUserById(payload.userId);
    if (!user) {
      res.status(401).json({ error: 'User not found.' });
      return;
    }
    req.authUser = { userId: user.id, email: user.email };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

/** Express middleware: like requireAuth, but only sets authUser if a valid
 *  token is present. Does NOT reject unauthenticated requests — callers
 *  should check req.authUser themselves. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(header.slice(7), JWT_SECRET!) as unknown as AuthUser;
      const user = getUserById(payload.userId);
      if (user) {
        req.authUser = { userId: user.id, email: user.email };
      }
    } catch {
      /* token invalid — fall through as anonymous */
    }
  }
  next();
}

/** Express middleware: authenticates via JWT OR webhook secret.
 *  Populates req.authUser for JWT-based calls; sets req.webhookAuthenticated
 *  for valid webhook-secret calls. */
export function webhookAuth(req: Request, res: Response, next: NextFunction): void {
  // Try JWT first.
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(header.slice(7), JWT_SECRET!) as unknown as AuthUser;
      const user = getUserById(payload.userId);
      if (user) {
        req.authUser = { userId: user.id, email: user.email };
        next();
        return;
      }
    } catch {
      /* fall through to webhook secret */
    }
  }

  // Try webhook secret (timing-safe comparison).
  const secret = getWebhookSecret();
  if (secret) {
    const provided = (req.headers['x-webhook-secret'] as string) || '';
    if (provided) {
      const a = Buffer.from(provided);
      const b = Buffer.from(secret);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        req.webhookAuthenticated = true;
        next();
        return;
      }
    }
  }

  res.status(401).json({ error: 'Valid JWT or x-webhook-secret required.' });
}

/** Type helper to extract authUser from a Request. */
export function getAuthUser(req: Request): AuthUser | undefined {
  return req.authUser;
}

/** Returns true if the request was authenticated via webhook secret. */
export function isWebhookAuthenticated(req: Request): boolean {
  return req.webhookAuthenticated === true;
}
