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
      return request(config, 'GET', '/api/buckets');
    },
  },

  create: {
    options: {
      protected: { type: 'boolean' },
    },
    async run(config, args) {
      const name = args.positional[0];
      if (!name) throw new Error('Usage: dockyard bucket create <name> [--protected]');
      return request(config, 'POST', '/api/buckets', {
        name,
        protected: !!args.flags.protected,
      });
    },
  },

  delete: {
    options: {},
    async run(config, args) {
      const name = args.positional[0];
      if (!name) throw new Error('Usage: dockyard bucket delete <name>');
      return request(config, 'DELETE', `/api/buckets/${encodeURIComponent(name)}`);
    },
  },
};
