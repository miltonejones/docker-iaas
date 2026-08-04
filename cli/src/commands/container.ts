import type { DockyardClientConfig } from '../client.js';
import { request } from '../client.js';
import type { ParsedArgs } from '../parse.js';

export const commands: Record<string, {
  options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>;
  run: (config: DockyardClientConfig, args: ParsedArgs) => Promise<unknown>;
}> = {
  list: {
    options: {
      project: { type: 'string' },
    },
    async run(config, args) {
      const projectId = args.flags.project as string | undefined;
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
      return request(config, 'GET', `/api/containers${qs}`);
    },
  },

  launch: {
    options: {
      image: { type: 'string' },
      name: { type: 'string' },
      port: { type: 'string', multiple: true },
      env: { type: 'string', multiple: true },
      project: { type: 'string' },
    },
    async run(config, args) {
      const ports = ((args.flags.port as string[]) || []).map((p) => {
        const [container, host] = p.split(':');
        return { container, host: parseInt(host, 10) };
      });
      const env = ((args.flags.env as string[]) || []).map((e) => {
        const [key, ...rest] = e.split('=');
        return { key, value: rest.join('=') };
      });
      return request(config, 'POST', '/api/containers', {
        image: args.flags.image,
        name: args.flags.name,
        ports: ports.length ? ports : undefined,
        env: env.length ? env : undefined,
        projectId: args.flags.project,
      });
    },
  },

  inspect: {
    options: {},
    async run(config, args) {
      const id = args.positional[0];
      if (!id) throw new Error('Usage: dockyard container inspect <id>');
      return request(config, 'GET', `/api/containers/${encodeURIComponent(id)}/inspect`);
    },
  },

  start: {
    options: {},
    async run(config, args) {
      const id = args.positional[0];
      if (!id) throw new Error('Usage: dockyard container start <id>');
      return request(config, 'POST', `/api/containers/${encodeURIComponent(id)}/start`);
    },
  },

  stop: {
    options: {},
    async run(config, args) {
      const id = args.positional[0];
      if (!id) throw new Error('Usage: dockyard container stop <id>');
      return request(config, 'POST', `/api/containers/${encodeURIComponent(id)}/stop`);
    },
  },

  restart: {
    options: {},
    async run(config, args) {
      const id = args.positional[0];
      if (!id) throw new Error('Usage: dockyard container restart <id>');
      return request(config, 'POST', `/api/containers/${encodeURIComponent(id)}/restart`);
    },
  },

  logs: {
    options: {
      tail: { type: 'string' },
    },
    async run(config, args) {
      const id = args.positional[0];
      if (!id) throw new Error('Usage: dockyard container logs <id> [--tail <n>]');
      const tail = args.flags.tail as string | undefined;
      const qs = tail ? `?tail=${tail}` : '';
      return request(config, 'GET', `/api/containers/${encodeURIComponent(id)}/logs${qs}`);
    },
  },

  delete: {
    options: {
      force: { type: 'boolean' },
    },
    async run(config, args) {
      const id = args.positional[0];
      if (!id) throw new Error('Usage: dockyard container delete <id> [--force]');
      const force = args.flags.force ? '?force=true' : '';
      return request(config, 'DELETE', `/api/containers/${encodeURIComponent(id)}${force}`);
    },
  },
};
