import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { createUser, getUserByEmail, getFirstUser } from '../db.js';
import { signToken, requireAuth, getAuthUser } from '../auth.js';

export const authRouter = Router();

// Shared secret that lets the automated issue consumer obtain a JWT without
// needing direct filesystem access to the SQLite database.  Set this env var
// on both the server and the consumer.  Falls back to the DB master key if no
// consumer-specific key is configured.
const CONSUMER_API_KEY = process.env.CONSUMER_API_KEY || '';

authRouter.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email?.trim() || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters.' });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Invalid email address.' });
      return;
    }

    const existing = getUserByEmail(email);
    if (existing) {
      res.status(409).json({ error: 'An account with this email already exists.' });
      return;
    }

    const hash = await bcrypt.hash(password, 10);
    const user = createUser(email, hash);
    const token = signToken(user);

    res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        portRangeStart: user.port_range_start,
        portRangeEnd: user.port_range_end,
      },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email?.trim() || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    const user = getUserByEmail(email);
    if (!user) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    res.json({
      token: signToken(user),
      user: {
        id: user.id,
        email: user.email,
        portRangeStart: user.port_range_start,
        portRangeEnd: user.port_range_end,
      },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

authRouter.get('/me', requireAuth, (req: Request, res: Response) => {
  const authUser = getAuthUser(req)!;
  res.json(authUser);
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
  const key = req.headers['x-consumer-api-key'] as string | undefined;
  if (!CONSUMER_API_KEY) {
    res.status(501).json({ error: 'Consumer API key not configured on the server.' });
    return;
  }
  if (!key || key !== CONSUMER_API_KEY) {
    res.status(401).json({ error: 'Invalid or missing consumer API key.' });
    return;
  }

  const user = getFirstUser();
  if (!user) {
    res.status(404).json({ error: 'No users in the database yet. Register an account first.' });
    return;
  }

  res.json({ token: signToken(user), userId: user.id, email: user.email });
});
