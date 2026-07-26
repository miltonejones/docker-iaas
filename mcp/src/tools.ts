import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { COMMON_TOOL_SCHEMAS, toMcpSchema } from '../../server/src/tool-schemas.js';

export const TOOL_DEFINITIONS: Tool[] = COMMON_TOOL_SCHEMAS.map(toMcpSchema);
