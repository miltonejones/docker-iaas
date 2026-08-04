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
      return request(config, 'GET', '/api/projects');
    },
  },

  create: {
    options: {
      name: { type: 'string' },
      description: { type: 'string' },
    },
    async run(config, args) {
      const name = args.flags.name as string | undefined;
      if (!name) throw new Error('Usage: dockyard project create --name <name> [--description <desc>]');
      return request(config, 'POST', '/api/projects', {
        name,
        description: (args.flags.description as string) ?? '',
      });
    },
  },

  delete: {
    options: {},
    async run(config, args) {
      const id = args.positional[0];
      if (!id) throw new Error('Usage: dockyard project delete <id>');
      return request(config, 'DELETE', `/api/projects/${encodeURIComponent(id)}`);
    },
  },
};
