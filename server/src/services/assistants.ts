import {
  listUserAssistants,
  getUserAssistant,
  createUserAssistant as createRow,
  updateUserAssistant as updateRow,
  deleteUserAssistant as deleteRow,
  type UserAssistantRow,
} from '../db.js';
import { HttpError } from './HttpError.js';

function toJson(r: UserAssistantRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    systemPrompt: r.system_prompt,
    toolList: JSON.parse(r.tool_list || '[]') as string[],
    voice: r.voice,
    icon: r.icon ?? null,
    isDefault: r.is_default === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** List all assistants belonging to the given user, plus the built-in default. */
export function list(userId: string) {
  const rows = listUserAssistants(userId);
  return rows.map(toJson);
}

export function get(id: string, userId: string) {
  const row = getUserAssistant(id, userId);
  if (!row) throw new HttpError(404, 'Assistant not found.');
  return toJson(row);
}

export function create(
  userId: string,
  input: {
    name: string;
    description?: string;
    systemPrompt?: string;
    toolList?: string[];
    voice?: string;
    icon?: string;
    isDefault?: boolean;
  },
) {
  if (!input.name?.trim()) throw new HttpError(400, 'Name is required.');
  const row = createRow({
    userId,
    name: input.name,
    description: input.description,
    systemPrompt: input.systemPrompt,
    toolList: input.toolList ? JSON.stringify(input.toolList) : undefined,
    voice: input.voice,
    icon: input.icon,
    isDefault: input.isDefault,
  });
  return toJson(row);
}

export function update(
  id: string,
  userId: string,
  fields: {
    name?: string;
    description?: string;
    systemPrompt?: string;
    toolList?: string[];
    voice?: string;
    icon?: string | null;
    isDefault?: boolean;
  },
) {
  const row = updateRow(id, userId, {
    name: fields.name,
    description: fields.description,
    systemPrompt: fields.systemPrompt,
    toolList: fields.toolList ? JSON.stringify(fields.toolList) : undefined,
    voice: fields.voice,
    icon: fields.icon,
    isDefault: fields.isDefault,
  });
  if (!row) throw new HttpError(404, 'Assistant not found.');
  return toJson(row);
}

export function remove(id: string, userId: string) {
  if (!deleteRow(id, userId)) throw new HttpError(404, 'Assistant not found.');
  return { ok: true };
}
