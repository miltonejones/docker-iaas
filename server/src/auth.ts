import { type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getUserById } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dockyard-dev-secret-change-in-production';
const JWT_EXPIRES_IN = '7d';

export interface AuthUser {
  userId: string;
  email: string;
}

/** Sign a JWT for the given user. */
export function signToken(user: { id: string; email: string }): string {
  return jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/** Express middleware: extracts and verifies the Authorization Bearer token,
 *  populating req.authUser. Returns 401 if absent, expired, or invalid. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization header required.' });
    return;
  }

  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as AuthUser;
    const user = getUserById(payload.userId);
    if (!user) {
      res.status(401).json({ error: 'User not found.' });
      return;
    }
    (req as unknown as Record<string, unknown>).authUser = { userId: user.id, email: user.email };
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
      const payload = jwt.verify(header.slice(7), JWT_SECRET) as AuthUser;
      const user = getUserById(payload.userId);
      if (user) {
        (req as unknown as Record<string, unknown>).authUser = { userId: user.id, email: user.email };
      }
    } catch {
      /* token invalid — fall through as anonymous */
    }
  }
  next();
}

/** Type helper to extract authUser from a Request. */
export function getAuthUser(req: Request): AuthUser | undefined {
  return (req as unknown as Record<string, unknown>).authUser as AuthUser | undefined;
}
