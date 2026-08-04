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
      return request(config, 'GET', '/api/gateway');
    },
  },

  create: {
    options: {
      domain: { type: 'string' },
      'target-type': { type: 'string' },
      'target-id': { type: 'string' },
      'target-port': { type: 'string' },
      method: { type: 'string' },
      'path-pattern': { type: 'string' },
    },
    async run(config, args) {
      const targetType = args.flags['target-type'] as string | undefined;
      const targetId = args.flags['target-id'] as string | undefined;
      if (!targetType || !targetId) {
        throw new Error('Usage: dockyard route create --target-type <type> --target-id <id> [--domain <domain>] [--target-port <port>] [--method <method>] [--path-pattern <pattern>]');
      }
      return request(config, 'POST', '/api/gateway', {
        name: `route-${Date.now()}`,
        targetType,
        targetId,
        targetPort: args.flags['target-port'] ? Number(args.flags['target-port']) : undefined,
        method: args.flags.method,
        pathPattern: args.flags['path-pattern'],
        domain: args.flags.domain,
      });
    },
  },

  delete: {
    options: {},
    async run(config, args) {
      const id = args.positional[0];
      if (!id) throw new Error('Usage: dockyard route delete <id>');
      return request(config, 'DELETE', `/api/gateway/${encodeURIComponent(id)}`);
    },
  },
};
