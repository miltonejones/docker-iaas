#!/usr/bin/env node

import readline from 'node:readline';
import { resolveConfig, loadConfig, saveConfig, deleteConfig, type Config } from './config.js';
import { request } from './client.js';
import { parse } from './parse.js';
import { printTable, printJson } from './output.js';
import { commands as containerCommands } from './commands/container.js';
import { commands as bucketCommands } from './commands/bucket.js';
import { commands as functionCommands } from './commands/function.js';
import { commands as routeCommands } from './commands/route.js';
import { commands as projectCommands } from './commands/project.js';

const RESOURCE_COMMANDS: Record<string, Record<string, {
  options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>;
  run: (config: Config, args: ReturnType<typeof parse>) => Promise<unknown>;
}>> = {
  container: containerCommands,
  bucket: bucketCommands,
  function: functionCommands,
  route: routeCommands,
  project: projectCommands,
};

const SPECIAL_COMMANDS = new Set(['login', 'logout', 'configure', 'help', '--help', '-h']);

async function main(): Promise<void> {
  const [first, second, ...rest] = process.argv.slice(2);

  if (!first || SPECIAL_COMMANDS.has(first)) {
    await runSpecialCommand(first, rest);
  } else {
    await runResourceCommand(first, second, rest);
  }
}

async function runSpecialCommand(cmd: string | undefined, _rest: string[]): Promise<void> {
  switch (cmd) {
    case 'login':
    case 'configure': {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

      const apiUrl = await ask('Dockyard API URL [http://localhost:4300]: ');
      const apiKey = await ask('API key: ');
      rl.close();

      const url = apiUrl.trim() || 'http://localhost:4300';
      const key = apiKey.trim();
      if (!key) {
        console.error('Error: API key is required.');
        process.exit(1);
      }

      // Validate the key before saving.
      try {
        await request({ apiUrl: url, apiKey: key }, 'GET', '/api/auth/me');
      } catch (err) {
        console.error(`Error: Could not authenticate — ${(err as Error).message}`);
        process.exit(1);
      }

      await saveConfig({ apiUrl: url, apiKey: key });
      console.log(`Logged in (${url}). Config saved to ~/.config/dockyard/config.json`);
      break;
    }
    case 'logout': {
      await deleteConfig();
      console.log('Logged out.');
      break;
    }
    case 'help':
    case '--help':
    case '-h':
    default: {
      console.log(`Usage: dockyard <resource> <verb> [options]

Resources and verbs:
  container  list, launch, inspect, start, stop, restart, logs, delete
  bucket     list, create, delete
  function   list, create, run, delete
  route      list, create, delete
  project    list, create, delete

Authentication:
  dockyard login      Save API URL and key to ~/.config/dockyard/config.json
  dockyard logout     Remove saved credentials

Global flags:
  --json              Output raw JSON instead of a table

Environment variables:
  DOCKYARD_API_URL    Override the API URL (useful for CI)
  DOCKYARD_API_KEY    Override the API key (useful for CI)
`);
      break;
    }
  }
}

async function runResourceCommand(
  resource: string,
  verb: string,
  rawArgs: string[],
): Promise<void> {
  const resourceCmds = RESOURCE_COMMANDS[resource];
  if (!resourceCmds) {
    console.error(`Error: Unknown resource '${resource}'.`);
    console.error('Available: container, bucket, function, route, project');
    process.exit(1);
  }

  const cmd = resourceCmds[verb];
  if (!cmd) {
    console.error(`Error: Unknown verb '${verb}' for resource '${resource}'.`);
    console.error(`Available verbs: ${Object.keys(resourceCmds).join(', ')}`);
    process.exit(1);
  }

  let config: Config;
  try {
    const fileCfg = await loadConfig();
    config = resolveConfig(fileCfg);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  const parsed = parse(rawArgs, cmd.options);

  try {
    const data = await cmd.run(config, parsed);
    if (parsed.json) {
      printJson(data);
    } else {
      if (Array.isArray(data)) {
        printTable(data as Record<string, unknown>[]);
      } else {
        printJson(data);
      }
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
