import { parseArgs } from 'node:util';

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | string[] | boolean>;
  json: boolean;
}

export type ParseOptions = Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>;

/**
 * Parse argv for a command that uses `node:util`'s parseArgs.
 * The global `--json` flag is stripped before passing to parseArgs.
 */
export function parse(
  rawArgs: string[],
  options: ParseOptions = {},
): ParsedArgs {
  // Separate --json from the rest so it never reaches a command's parseArgs schema.
  const json = rawArgs.includes('--json');
  const argsForParse = rawArgs.filter((a) => a !== '--json');

  const result = parseArgs({
    args: argsForParse,
    options,
    allowPositionals: true,
    strict: false, // unknown flags become positionals — we handle them in the command
  });

  return {
    positional: result.positionals,
    flags: result.values as Record<string, string | string[] | boolean>,
    json,
  };
}
