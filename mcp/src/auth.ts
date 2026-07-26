import jwt from 'jsonwebtoken';
import { loadJwtSecret } from '../../server/src/auth.js';
import { getUserById, getFirstUser } from '../../server/src/db.js';

let jwtSecret: string | null = null;

export async function initAuth(): Promise<void> {
  jwtSecret = loadJwtSecret();
  if (!jwtSecret) {
    throw new Error('JWT secret not found. Set JWT_SECRET env var.');
  }
}

export function resolveUserId(): string | undefined {
  if (!jwtSecret) return undefined;

  // Priority 1: DOCKYARD_JWT — a pre-obtained JWT token
  const jwtToken = process.env.DOCKYARD_JWT;
  if (jwtToken) {
    try {
      const payload = jwt.verify(jwtToken, jwtSecret) as { userId: string };
      const user = getUserById(payload.userId);
      if (user) return user.id;
    } catch {
      // invalid token — fall through
    }
  }

  // Priority 2: DOCKYARD_API_KEY — validate against CONSUMER_API_KEY
  const apiKey = process.env.DOCKYARD_API_KEY;
  if (apiKey && process.env.CONSUMER_API_KEY) {
    if (apiKey !== process.env.CONSUMER_API_KEY) return undefined;
    const user = getFirstUser();
    return user?.id;
  }

  // No auth configured
  return undefined;
}
