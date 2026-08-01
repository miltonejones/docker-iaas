import jwt from 'jsonwebtoken';
import { loadJwtSecret } from '../../server/src/auth.js';
import { getUserById, getFirstUser, getUserAssistant } from '../../server/src/db.js';

let jwtSecret: string | null = null;

export async function initAuth(): Promise<void> {
  jwtSecret = loadJwtSecret();
  if (!jwtSecret) {
    throw new Error('JWT secret not found. Set JWT_SECRET env var.');
  }
}

export function resolveUserId(): string | undefined {
  if (!jwtSecret) return undefined;

  // Priority 1: DOCKYARD_JWT — a pre-obtained JWT token verified against JWT_SECRET
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

/** Resolve the DOCKYARD_ASSISTANT_ID env var to a valid assistant ID.
 *  When set, the MCP server will only expose tools that are in that
 *  assistant's tool_list. If the env var is not set, or the assistant
 *  doesn't exist, returns null (meaning: all tools are available). */
export function resolveAssistantId(): string | null {
  const id = process.env.DOCKYARD_ASSISTANT_ID;
  if (!id) return null;
  const userId = resolveUserId();
  if (!userId) return null;
  const assistant = getUserAssistant(id, userId);
  return assistant ? id : null;
}