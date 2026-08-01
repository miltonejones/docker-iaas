import { Router, type Request, type Response } from 'express';
import { requireAuth, getAuthUser, requireRole } from '../auth.js';
import { HttpError } from '../services/HttpError.js';
import * as authService from '../services/auth.js';
import { listUsers, setUserRole, countUsersByRole, deleteUser, getUserById } from '../db.js';

export const authRouter = Router();

function sendError(res: Response, err: unknown): void {
  const status = err instanceof HttpError ? err.status : 500;
  res.status(status).json({ error: err instanceof Error ? err.message : 'Unknown error.' });
}

authRouter.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    const result = await authService.register(email || '', password || '');
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
});

authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    res.json(await authService.login(email || '', password || ''));
  } catch (err) {
    sendError(res, err);
  }
});

authRouter.get('/me', requireAuth, (req: Request, res: Response) => {
  const authUser = getAuthUser(req)!;
  res.json(authUser);
});

authRouter.get('/settings', requireAuth, (req: Request, res: Response) => {
  const user = getAuthUser(req)!;
  res.json(authService.getSettings(user.userId));
});

authRouter.put('/settings', requireAuth, (req: Request, res: Response) => {
  const user = getAuthUser(req)!;
  authService.updateSettings(user.userId, req.body as Record<string, unknown>);
  res.json({ ok: true });
});

/** Exchange a pre-shared consumer API key for a JWT.  Lets the automated issue
 *  consumer authenticate without needing direct filesystem access to the SQLite
 *  database (which would require better-sqlite3 native deps).
 *
 *  The consumer sends the key via the `x-consumer-api-key` header.  The same
 *  key must be set as CONSUMER_API_KEY on the server.  Returns a JWT for the
 *  first user in the database so the consumer has a tenant identity for
 *  reading and updating per-user issues. */
authRouter.post('/consumer', (req: Request, res: Response) => {
  try {
    const key = req.headers['x-consumer-api-key'] as string | undefined;
    res.json(authService.exchangeConsumerKey(key));
  } catch (err) {
    sendError(res, err);
  }
});

// ── User management (admin only) ─────────────────────────────

const VALID_ROLES = ['admin', 'operator', 'viewer'] as const;

authRouter.get('/users', requireAuth, requireRole('admin'), (_req: Request, res: Response) => {
  res.json(listUsers());
});

authRouter.patch('/users/:id', requireAuth, requireRole('admin'), (req: Request, res: Response) => {
  try {
    const authUser = getAuthUser(req)!;
    const { role } = req.body as { role?: string };

    if (!role || !VALID_ROLES.includes(role as typeof VALID_ROLES[number])) {
      res.status(400).json({ error: 'Invalid role. Must be admin, operator, or viewer.' });
      return;
    }

    // Prevent demoting the last remaining admin.
    if (role !== 'admin' && countUsersByRole('admin') <= 1) {
      const targetUser = listUsers().find((u) => u.id === req.params.id);
      if (targetUser?.role === 'admin') {
        res.status(400).json({ error: 'You cannot demote the last remaining admin.' });
        return;
      }
    }

    if (!setUserRole(req.params.id, role as 'admin' | 'operator' | 'viewer')) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

authRouter.delete('/users/:id', requireAuth, requireRole('admin'), (req: Request, res: Response) => {
  try {
    const authUser = getAuthUser(req)!;

    if (req.params.id === authUser.userId) {
      res.status(400).json({ error: 'You cannot delete your own account.' });
      return;
    }

    // Check BEFORE deleting: cannot remove the last remaining admin.
    if (countUsersByRole('admin') <= 1) {
      const target = getUserById(req.params.id);
      if (target && target.role === 'admin') {
        res.status(400).json({ error: 'You cannot delete the last remaining admin.' });
        return;
      }
    }

    if (!deleteUser(req.params.id)) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});
