import fs from 'node:fs';
import type { DockyardClientConfig } from '../client.js';
import { request } from '../client.js';
import type { ParsedArgs } from '../parse.js';

export const commands: Record<string, {
  options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>;
  run: (config: DockyardClientConfig, args: ParsedArgs) => Promise<unknown>;
}> = {
  list: {
    options: {},
    async run(config, _args) {
      return request(config, 'GET', '/api/lambda/functions');
    },
  },

  create: {
    options: {
      name: { type: 'string' },
      runtime: { type: 'string' },
      code: { type: 'string' },
    },
    async run(config, args) {
      const name = args.flags.name as string | undefined;
      const runtime = args.flags.runtime as string | undefined;
      const codeFlag = args.flags.code as string | undefined;
      if (!name) throw new Error('Usage: dockyard function create --name <name> --runtime <runtime> [--code @path/to/file]');
      if (!runtime) throw new Error('--runtime is required.');

      let code = '';
      if (codeFlag) {
        if (codeFlag.startsWith('@')) {
          const filePath = codeFlag.slice(1);
          code = fs.readFileSync(filePath, 'utf8');
        } else {
          code = codeFlag;
        }
      }

      return request(config, 'POST', '/api/lambda/functions', {
        name,
        runtime,
        code,
      });
    },
  },

  run: {
    options: {
      id: { type: 'string' },
      payload: { type: 'string' },
    },
    async run(config, args) {
      const id = args.flags.id as string | undefined;
      if (!id) throw new Error('Usage: dockyard function run --id <functionId> [--payload <json>]');
      let payload: unknown;
      if (args.flags.payload) {
        try {
          payload = JSON.parse(args.flags.payload as string);
        } catch {
          throw new Error('--payload must be valid JSON.');
        }
      }
      const body: Record<string, unknown> = { functionId: id };
      if (payload !== undefined) body.payload = payload;
      return request(config, 'POST', '/api/lambda/run', body);
    },
  },

  delete: {
    options: {},
    async run(config, args) {
      const id = args.positional[0];
      if (!id) throw new Error('Usage: dockyard function delete <id>');
      return request(config, 'DELETE', `/api/lambda/functions/${encodeURIComponent(id)}`);
    },
  },
};
