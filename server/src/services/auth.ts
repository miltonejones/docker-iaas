import bcrypt from 'bcryptjs';
import {
  createUser,
  getUserByEmail,
  getFirstUser,
  getAllUserSettings,
  setUserSetting,
  deleteUserSetting,
} from '../db.js';
import { signToken } from '../auth.js';
import { HttpError } from './HttpError.js';

const SETTABLE_KEYS = [
  'anthropic_api_key',
  'deepseek_api_key',
  'github_token',
  'aws_access_key_id',
  'aws_secret_access_key',
  'assistant_provider',
];

export async function register(email: string, password: string) {
  if (!email?.trim() || !password) {
    throw new HttpError(400, 'Email and password are required.');
  }
  if (password.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'Invalid email address.');
  }

  const existing = getUserByEmail(email);
  if (existing) {
    throw new HttpError(409, 'An account with this email already exists.');
  }

  const hash = await bcrypt.hash(password, 10);
  const user = createUser(email, hash);
  const token = signToken(user);

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      portRangeStart: user.port_range_start,
      portRangeEnd: user.port_range_end,
    },
  };
}

export async function login(email: string, password: string) {
  if (!email?.trim() || !password) {
    throw new HttpError(400, 'Email and password are required.');
  }

  const user = getUserByEmail(email);
  if (!user) {
    throw new HttpError(401, 'Invalid email or password.');
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new HttpError(401, 'Invalid email or password.');
  }

  return {
    token: signToken(user),
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      portRangeStart: user.port_range_start,
      portRangeEnd: user.port_range_end,
    },
  };
}

export function getSettings(userId: string) {
  const settings = getAllUserSettings(userId);
  const out: Record<string, { configured: boolean }> = {};
  for (const key of SETTABLE_KEYS) {
    out[key] = { configured: !!settings[key] };
  }
  return out;
}

export function updateSettings(userId: string, body: Record<string, unknown>) {
  for (const key of SETTABLE_KEYS) {
    if (body[key] === undefined) continue;
    if (body[key] === null || body[key] === '') {
      deleteUserSetting(userId, key);
    } else if (typeof body[key] === 'string') {
      setUserSetting(userId, key, body[key] as string);
    }
  }
}

export function exchangeConsumerKey(key: string | undefined) {
  const CONSUMER_API_KEY = process.env.CONSUMER_API_KEY || '';
  if (!CONSUMER_API_KEY) {
    throw new HttpError(501, 'Consumer API key not configured on the server.');
  }
  if (!key || key !== CONSUMER_API_KEY) {
    throw new HttpError(401, 'Invalid or missing consumer API key.');
  }

  const user = getFirstUser();
  if (!user) {
    throw new HttpError(404, 'No users in the database yet. Register an account first.');
  }

  return { token: signToken(user), userId: user.id, email: user.email };
}
