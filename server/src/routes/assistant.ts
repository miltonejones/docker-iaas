import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { GetObjectCommand, ListBucketsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { docker } from '../docker.js';
import { stripLogHeaders } from './containers.js';
import {
  listFunctions,
  getFunction,
  listRoutes,
  listAssistantSessions,
  getAssistantSession,
  createAssistantSession,
  updateAssistantSession,
  deleteAssistantSession,
} from '../db.js';
import { getS3Client } from '../minio.js';
import { PRESETS } from '../presets.js';

export const assistantRouter = Router();

/** ANTHROPIC_API_KEY takes precedence when set. Otherwise fall back, in
 *  order, to: the Docker Compose secret mounted at /run/secrets (production
 *  container — see docker-compose.yml), then ~/.antro (this machine's
 *  personal key file, for `npm run dev` on the host). Read once at startup,
 *  never logged, never written anywhere else. */
function resolveApiKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return undefined; // let the SDK read it from env itself
  const candidates = ['/run/secrets/anthropic_api_key', path.join(os.homedir(), '.antro')];
  for (const file of candidates) {
    try {
      const key = fs.readFileSync(file, 'utf8').trim();
      if (key) return key;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

const client = new Anthropic({ apiKey: resolveApiKey(), baseURL: 'https://api.anthropic.com' });

const SYSTEM = `You are the Dockyard.ai assistant. You translate a user's natural-language request into tool calls that manage Lambda functions, Gateway routes, containers, Docker images, and storage buckets.

Rules:
- Always call a tool rather than describing what you would do. Never invent a resource id.
- If the user names a resource by a friendly name/description rather than an id, and you don't already have that id from the user's message or an earlier tool result, first call the matching list_* tool to look it up (list_containers, list_functions, list_gateway_routes, list_buckets, list_images — these run automatically, no confirmation needed). If exactly one result matches, use its id. If there's no match or more than one plausible match, ask the user to clarify rather than guessing.
- When the user refers to a resource vaguely ("the function", "it", "that one", "this bucket") without naming it, first check whether an earlier message or tool result in this same conversation already established which one. If exactly one resource was clearly the subject of the recent exchange, use its id directly without re-listing or re-asking. Only fall back to list_* or asking the user to clarify when no such resource is evident from the conversation so far.
- When the user asks what a function does or wants to see its code, call read_function with its id — list_functions only returns id/name/runtime, not the source code. read_function runs automatically (no confirmation needed) and returns the full function details including code, runtime, packages, and entry point.
- Before editing a file that might already exist in a bucket (e.g. "change the title", "add a button", "fix the CSS"), call list_bucket_objects and read_bucket_object first and base the edit on the real current content — never blindly regenerate a file from scratch when the request implies an existing one. write_bucket_object always replaces a file's entire content, so the new content you send must include everything you want kept, not just the changed part.
- For multi-step requests (e.g. "create a function and attach a gateway route to it"), call one tool at a time and wait for its real result before calling the next one — never invent an id.
- Default runtime is "node" unless the user names another ("python" or "sh").
- When writing a function's "code", write complete, runnable source for the chosen runtime. Functions invoked through a gateway route follow this contract: the incoming request arrives as JSON in the DOCKYARD_REQUEST environment variable, shaped like { httpMethod, path, headers, queryStringParameters, body, isBase64Encoded } (body may be null). The function must print exactly one JSON object to stdout shaped like { "statusCode": number, "headers"?: object, "body": string, "isBase64Encoded"?: boolean }. Do not print anything else to stdout.
- When a gateway route targets a lambda function, targetType must be "lambda" and targetId must be the id returned by the create_lambda_function call. When it targets a bucket, targetType must be "bucket" and targetId is simply the bucket's name.
- gateway route "pathPattern" is matched by EXACT string equality against the incoming request path (with the route's own name already stripped from the front) — there is no wildcard, glob, or prefix support. A trailing "/*" or "/:id" will never match anything real; do not use them. To match every path and method under a route (a whole static site, or a REST resource with multiple sub-paths like "/todos" and "/todos/{id}"), omit both "method" and "pathPattern" entirely rather than guessing a pattern.
- To host a static website on a BUCKET (the default, simplest path): create the bucket first if it doesn't already exist (check with list_buckets), write each file with write_bucket_object (e.g. "index.html", "style.css", "script.js" — one tool call per file), then create_gateway_route with targetType "bucket" and targetId set to the bucket name, omitting method and pathPattern so every file in the site is reachable. Requests to "/" or a path with no file extension serve "index.html" (SPA-style fallback).
- To host a site on an OS CONTAINER instead (when the user asks for a container/VM/server, needs a long-running process, dynamic requests, or explicitly wants it on a container rather than a bucket): call launch_container with a serving image — prefer "nginx:alpine" for static sites because its default command serves /usr/share/nginx/html on port 80 with no extra setup. Write each site file with write_container_file to that directory (e.g. "/usr/share/nginx/html/index.html", "/usr/share/nginx/html/style.css" — one call per file). Then create_gateway_route with targetType "container", targetId set to the container id returned by launch_container, targetPort 80, omitting method and pathPattern so every path reaches the container. Use this path only when a container is genuinely wanted; otherwise default to the bucket path.
- Destructive or disruptive actions (delete_*, prune_*, container_action) still go through the normal tool-call flow — the user reviews and confirms every tool call before it executes, so call the tool directly rather than asking "are you sure?" in text first. write_container_file and launch_container are no exception: call them directly; the user confirms before they run.
- When done, give a short (1-2 sentence) confirmation of what was done — no more.`;

const tools: Anthropic.Tool[] = [
  {
    name: 'create_lambda_function',
    description:
      'Create a new Lambda-style function in Dockyard.ai. Call this when the user wants to create/define a function.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Function name' },
        runtime: { type: 'string', enum: ['node', 'python', 'sh'], description: 'Defaults to node' },
        code: { type: 'string', description: "Complete source code for the function's entry file" },
        packages: { type: 'string', description: 'Space-separated packages to install, if any' },
        entryPoint: { type: 'string', description: 'Entry filename, e.g. index.js' },
      },
      required: ['name', 'code'],
    },
  },
  {
    name: 'create_gateway_route',
    description:
      'Create an API Gateway route pointing at a target resource. Call this when the user wants to expose or attach an endpoint. For targetType "lambda", targetId is the id returned by create_lambda_function. For targetType "bucket", targetId is just the bucket name (no lookup needed) — use this to serve a static site written with write_bucket_object. For targetType "container", targetId is the container id returned by launch_container and targetPort is the port the server listens on inside that container (e.g. 80 for nginx) — use this to serve a site hosted on an OS container written with write_container_file.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Route name: lowercase letters/digits/hyphens, starting with a letter or digit' },
        targetType: { type: 'string', enum: ['lambda', 'container', 'bucket'] },
        targetId: { type: 'string' },
        targetPort: {
          type: 'number',
          description:
            'For targetType "container" only: the port the server listens on inside the target container (e.g. 80 for nginx). Omit for lambda/bucket targets.',
        },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] },
        pathPattern: {
          type: 'string',
          description:
            'Must start with "/". Matched by EXACT string equality against the request path — no wildcards or path params (a trailing "/*" or "/:id" never matches). Omit this (and method) entirely for a catch-all route matching every path/method, which is usually what you want for a bucket-hosted site, a container-hosted site, or a multi-path REST resource.',
        },
      },
      required: ['name', 'targetType', 'targetId'],
    },
  },
  {
    name: 'update_lambda_function',
    description: "Update an existing Lambda function's name, runtime, code, or packages.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Function id, e.g. fn-abc123' },
        name: { type: 'string' },
        runtime: { type: 'string', enum: ['node', 'python', 'sh'] },
        code: { type: 'string' },
        packages: { type: 'string', description: 'Space-separated packages to install' },
        entryPoint: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_lambda_function',
    description: 'Delete a saved Lambda function by id.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'delete_gateway_route',
    description: 'Delete a gateway route by id.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'launch_container',
    description: 'Launch a new Docker container, either from a named preset or a raw image.',
    input_schema: {
      type: 'object',
      properties: {
        presetId: { type: 'string', description: 'A known preset id, if the user named one' },
        image: { type: 'string', description: 'Docker image (e.g. "redis:7-alpine"), if not using a preset' },
        name: { type: 'string', description: 'Container name' },
        ports: {
          type: 'array',
          description: 'Port mappings',
          items: {
            type: 'object',
            properties: {
              container: { type: 'string', description: 'Container-side port, e.g. "6379" or "6379/tcp"' },
              host: { type: 'number', description: 'Host-side port' },
            },
            required: ['container', 'host'],
          },
        },
        env: {
          type: 'array',
          description: 'Environment variables',
          items: {
            type: 'object',
            properties: { key: { type: 'string' }, value: { type: 'string' } },
            required: ['key', 'value'],
          },
        },
      },
      required: [],
    },
  },
  {
    name: 'container_action',
    description: 'Start, stop, or restart an existing container.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Container id' },
        action: { type: 'string', enum: ['start', 'stop', 'restart'] },
      },
      required: ['id', 'action'],
    },
  },
  {
    name: 'write_container_file',
    description:
      'Write (create or overwrite) a text file inside a running container at an absolute path. Use this to host a static site on an OS container: launch a serving image such as nginx:alpine (which serves /usr/share/nginx/html on port 80 by default), write each site file there (e.g. /usr/share/nginx/html/index.html, /usr/share/nginx/html/style.css), then create_gateway_route with targetType "container", targetId set to that container id, and targetPort 80.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Container id (from launch_container or list_containers)' },
        path: {
          type: 'string',
          description: 'Absolute path inside the container, e.g. "/usr/share/nginx/html/index.html"',
        },
        content: { type: 'string', description: "The file's full text content" },
      },
      required: ['id', 'path', 'content'],
    },
  },
  {
    name: 'delete_container',
    description: 'Remove a container by id.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        force: { type: 'boolean', description: 'Force-remove even if running' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_image',
    description: 'Remove a Docker image by id.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        force: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'prune_images',
    description: 'Prune unused/dangling Docker images and stopped containers to reclaim disk space. Takes no arguments.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_bucket',
    description: 'Create a new storage bucket.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'delete_bucket',
    description: 'Delete a storage bucket by name. Fails if the bucket is not empty.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'delete_bucket_object',
    description: 'Delete a single object (file) from a storage bucket.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Bucket name' },
        key: { type: 'string', description: 'Object key/path within the bucket' },
      },
      required: ['name', 'key'],
    },
  },
  {
    name: 'write_bucket_object',
    description:
      'Write (create or overwrite) a text file in a storage bucket — the bucket must already exist. Use this to build a static website: write "index.html", "style.css", "script.js", etc., one file per call, then create_gateway_route with targetType "bucket" to serve them.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Bucket name' },
        key: { type: 'string', description: 'Object key/path within the bucket, e.g. "index.html" or "assets/style.css"' },
        content: { type: 'string', description: "The file's full text content" },
        contentType: {
          type: 'string',
          description: 'MIME type, e.g. text/html, text/css, application/javascript, application/json. Defaults to text/plain.',
        },
      },
      required: ['name', 'key', 'content'],
    },
  },
  {
    name: 'prune_build_cache',
    description: 'Prune the Docker build cache to reclaim disk space. Takes no arguments.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_containers',
    description: 'List all containers (id, name, image, state) — use this to resolve a container the user referred to by name to its id.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_functions',
    description: "List all saved Lambda functions (id, name, runtime) — use this to resolve a function's name to its id.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_gateway_routes',
    description: "List all gateway routes (id, name, targetType, targetId, method, pathPattern) — use this to resolve a route's name to its id.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_buckets',
    description: 'List all storage buckets (name).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_images',
    description: "List all Docker images (id, tags) — use this to resolve an image's tag to its id.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_bucket_objects',
    description:
      'List the files (and folder-like prefixes) inside a bucket, optionally under a prefix. Use this before modifying an existing bucket-hosted site to see what files already exist.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Bucket name' },
        prefix: { type: 'string', description: 'Only list keys under this prefix, e.g. "assets/"' },
      },
      required: ['name'],
    },
  },
  {
    name: 'read_bucket_object',
    description:
      "Read a text file's content from a bucket. Use this before editing an existing file with write_bucket_object, so the edit is based on the real current content rather than a guess.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Bucket name' },
        key: { type: 'string', description: 'Object key/path within the bucket, e.g. "index.html"' },
      },
      required: ['name', 'key'],
    },
  },
  {
    name: 'read_function',
    description:
      "Read a Lambda function's full details including its source code, runtime, packages, and entry point. Use this when the user asks what a function does or wants to see its code — list_functions only returns id/name/runtime, not the code itself.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Function id, e.g. fn-abc123' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_container_logs',
    description:
      "Fetch a container's recent stdout/stderr log output (read-only, runs automatically with no confirmation). Use this when the user asks what a container is doing, why it isn't working, or wants to see its logs. Returns up to `tail` lines (default 200).",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Container id (from list_containers or launch_container)' },
        tail: { type: 'number', description: 'Number of recent lines to fetch (default 200, max 500)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'inspect_container',
    description:
      "Inspect a container's configuration (read-only, runs automatically with no confirmation): image, state, published ports, volumes, restart policy, and labels. Environment variable VALUES are redacted for safety — only the env var NAMES are returned. Use this when the user asks how a container is configured or what it's running.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Container id' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_presets',
    description:
      'List the launchable image presets (the gallery of quick-start images — analogous to AMIs): each preset has an id, name, category, image, description, suggested ports and env defaults. Use this when the user asks what they can launch or wants to pick a preset to run. Read-only, runs automatically with no confirmation.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_used_ports',
    description:
      'List the host ports currently published by running containers (read-only, runs automatically with no confirmation). Use this before launching a container with a specific host port to avoid a conflict, or when the user asks what ports are in use.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'run_function',
    description:
      'Run a saved Lambda function by id and return its stdout, status code, and duration. Use this when the user asks to test or run a function. An optional JSON `payload` is provided to the function as the DOCKYARD_REQUEST environment variable (the gateway contract); omit it for functions that take no request. The function runs with its saved environment variables, the same as the editor Run button and gateway invocations. The user confirms before it runs.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Function id, e.g. fn-abc123' },
        payload: {
          type: 'object',
          description: 'Optional request payload passed to the function as DOCKYARD_REQUEST (JSON)',
        },
      },
      required: ['id'],
    },
  },
];

/** These tools have no side effects, so the server executes them itself and
 *  loops back to Claude immediately — the client never sees them and never
 *  has to confirm a plain lookup. */
const READ_ONLY_TOOLS = new Set([
  'list_containers',
  'list_functions',
  'list_gateway_routes',
  'list_buckets',
  'list_images',
  'list_bucket_objects',
  'read_bucket_object',
  'read_function',
  'get_container_logs',
  'inspect_container',
  'list_presets',
  'list_used_ports',
]);

/** Caps how much of a bucket object's content gets fed back to Claude — a
 *  multi-MB asset would otherwise blow up the conversation's token count. */
const MAX_OBJECT_READ_CHARS = 50_000;

async function streamToString(body: unknown): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function executeReadOnlyTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_containers': {
      const list = await docker.listContainers({ all: true });
      return list.map((c) => ({
        id: c.Id,
        name: (c.Names?.[0] || '').replace(/^\//, ''),
        image: c.Image,
        state: c.State,
      }));
    }
    case 'list_functions':
      return listFunctions().map((f) => ({ id: f.id, name: f.name, runtime: f.runtime }));
    case 'list_gateway_routes':
      return listRoutes().map((r) => ({
        id: r.id,
        name: r.name,
        targetType: r.target_type,
        targetId: r.target_id,
        method: r.method,
        pathPattern: r.path_pattern,
      }));
    case 'list_buckets': {
      const out = await getS3Client().send(new ListBucketsCommand({}));
      return (out.Buckets || []).map((b) => ({ name: b.Name }));
    }
    case 'list_images': {
      const list = await docker.listImages();
      return list.map((img) => ({ id: img.Id, tags: img.RepoTags || [] }));
    }
    case 'list_bucket_objects': {
      const prefix = typeof input.prefix === 'string' ? input.prefix : '';
      const out = await getS3Client().send(
        new ListObjectsV2Command({ Bucket: String(input.name ?? ''), Prefix: prefix, Delimiter: '/' }),
      );
      return {
        prefixes: (out.CommonPrefixes || []).map((p) => p.Prefix).filter(Boolean),
        objects: (out.Contents || [])
          .filter((o) => o.Key !== prefix)
          .map((o) => ({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified })),
      };
    }
    case 'read_bucket_object': {
      const out = await getS3Client().send(
        new GetObjectCommand({ Bucket: String(input.name ?? ''), Key: String(input.key ?? '') }),
      );
      const content = await streamToString(out.Body);
      const truncated = content.length > MAX_OBJECT_READ_CHARS;
      return {
        contentType: out.ContentType,
        content: truncated ? content.slice(0, MAX_OBJECT_READ_CHARS) : content,
        truncated,
      };
    }
    case 'read_function': {
      const fn = getFunction(String(input.id ?? ''));
      if (!fn) return { error: `Function "${input.id}" not found.` };
      return {
        id: fn.id,
        name: fn.name,
        runtime: fn.runtime,
        code: fn.code,
        packages: fn.packages || null,
        entryPoint: fn.entry_point || null,
        createdAt: fn.created_at,
        updatedAt: fn.updated_at,
      };
    }
    case 'get_container_logs': {
      const id = String(input.id ?? '');
      const tailNum = Number.isFinite(input.tail) ? Number(input.tail) : 200;
      const tail = Math.max(1, Math.min(500, Math.trunc(tailNum) || 200));
      const buf = await docker.getContainer(id).logs({
        stdout: true,
        stderr: true,
        tail,
        timestamps: false,
      });
      const text = stripLogHeaders(buf as unknown as Buffer);
      const MAX_LOG_CHARS = 20_000;
      const truncated = text.length > MAX_LOG_CHARS;
      return {
        tail,
        content: truncated ? text.slice(0, MAX_LOG_CHARS) : text,
        truncated,
      };
    }
    case 'inspect_container': {
      const info = await docker.getContainer(String(input.id ?? '')).inspect();
      // Env VALUES may contain secrets — return only the variable NAMES, never
      // the values, per secrets hygiene.
      const envNames = (info.Config?.Env || []).map((e) => e.split('=')[0]);
      return {
        id: info.Id,
        name: (info.Name || '').replace(/^\//, ''),
        image: info.Config?.Image ?? '',
        state: info.State?.Status ?? 'unknown',
        ports: info.NetworkSettings?.Ports
          ? Object.entries(info.NetworkSettings.Ports).flatMap(([key, bindings]) => {
              const [port, proto] = key.split('/');
              return (bindings || []).map((b) => ({
                privatePort: Number(port),
                publicPort: b?.HostPort ? Number(b.HostPort) : undefined,
                type: proto || 'tcp',
              }));
            })
          : [],
        env: envNames,
        volumes: (info.Mounts || []).map((m) => ({
          source: m.Source ?? '',
          destination: m.Destination ?? '',
          type: m.Type ?? 'volume',
        })),
        restartPolicy: info.HostConfig?.RestartPolicy?.Name ?? 'no',
        labels: info.Config?.Labels ?? {},
      };
    }
    case 'list_presets':
      return PRESETS.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        image: p.image,
        description: p.description,
        ports: (p.ports || []).map((pp) => ({ container: pp.container, host: pp.host })),
      }));
    case 'list_used_ports': {
      const list = await docker.listContainers({ all: true });
      const used = new Set<number>();
      for (const c of list) {
        for (const p of c.Ports || []) {
          if (p.PublicPort) used.add(p.PublicPort);
        }
      }
      return { ports: Array.from(used).sort((a, b) => a - b) };
    }
    default:
      throw new Error(`Unknown read-only tool "${name}".`);
  }
}

async function safeExecuteReadOnly(name: string, input: Record<string, unknown>): Promise<{ ok: boolean; content: unknown }> {
  try {
    return { ok: true, content: await executeReadOnlyTool(name, input) };
  } catch (err) {
    return { ok: false, content: { error: (err as Error).message } };
  }
}

interface PendingAction {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ResolvedResult {
  toolUseId: string;
  ok: boolean;
  content: unknown;
}

interface TurnResponse {
  messages: Anthropic.MessageParam[];
  pending: PendingAction[];
  /** Read-only tool calls the server already resolved on the client's behalf
   *  in this same turn (only present alongside `pending` when a turn mixed
   *  read-only and mutating calls — see the loop in respond() below). The
   *  client must merge these into its own resolved-results accumulator and
   *  send them back untouched on /confirm, since Claude expects every
   *  tool_result for a turn together. */
  autoResolved: ResolvedResult[];
  done: boolean;
  text: string;
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

const MAX_AUTO_ROUNDS = 8;

/** Stream `messages` to Claude via SSE and keep looping as long as every tool
 *  call in a turn is read-only — those get executed here immediately and fed
 *  back without ever reaching the client. As soon as a turn has no tool calls
 *  (done) or includes a mutating one, the final turn data is sent as an SSE
 *  event and the stream ends. Text deltas are streamed to the client in
 *  real-time so the user sees the model's response as it's generated.
 *  Mutating tools are never executed here — that stays the client's job,
 *  after the user confirms. */
async function respondStream(
  messages: Anthropic.MessageParam[],
  req: Request,
  res: Response,
): Promise<void> {
  // Don't flush headers early — let the first res.write() send them
  // implicitly with chunked transfer encoding. Flushing early causes the
  // client to see headers with no body and close the connection.
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.status(200);

  const send = (data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let aborted = false;
  // Use the response's 'close' event to detect client disconnect — the
  // request's 'close' fires as soon as the request body is parsed, which
  // is before we even start streaming.
  res.on('close', () => {
    if (!res.writableFinished) {
      aborted = true;
    }
  });

  try {
    for (let round = 0; round < MAX_AUTO_ROUNDS; round++) {
      if (aborted) return;

      const stream = client.messages.stream({
        model: 'claude-opus-4-8',
        max_tokens: 4096,
        system: SYSTEM,
        tools,
        messages,
      });

      // Stream text deltas to the client in real-time.
      stream.on('text', (delta) => {
        if (!aborted) send({ type: 'text', delta });
      });

      // Wait for the full message (this also drives the stream to completion,
      // so the 'text' listener above fires as chunks arrive).
      let finalMessage: Anthropic.Message;
      try {
        finalMessage = await stream.finalMessage();
      } catch (err) {
        if (aborted) return;
        throw err;
      }
      if (aborted) return;

      messages.push({ role: 'assistant', content: finalMessage.content });

      const toolUses = finalMessage.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      const readOnlyCalls = toolUses.filter((b) => READ_ONLY_TOOLS.has(b.name));
      const mutatingCalls = toolUses.filter((b) => !READ_ONLY_TOOLS.has(b.name));

      if (toolUses.length === 0) {
        send({
          type: 'turn',
          messages,
          pending: [],
          autoResolved: [],
          done: true,
          text: extractText(finalMessage.content),
        });
        res.end();
        return;
      }

      if (mutatingCalls.length > 0) {
        // Can't resolve the read-only calls alone — every tool_result for
        // this turn has to go back together, and the mutating one(s) need a
        // client-side decision first. Compute the read-only results now and
        // hand them to the client to hold until the mutating ones are answered.
        const autoResolved: ResolvedResult[] = await Promise.all(
          readOnlyCalls.map(async (b) => {
            const r = await safeExecuteReadOnly(b.name, b.input as Record<string, unknown>);
            return { toolUseId: b.id, ok: r.ok, content: r.content };
          }),
        );
        if (aborted) return;
        send({
          type: 'turn',
          messages,
          pending: mutatingCalls.map((b) => ({
            id: b.id,
            name: b.name,
            input: b.input as Record<string, unknown>,
          })),
          autoResolved,
          done: false,
          text: extractText(finalMessage.content),
        });
        res.end();
        return;
      }

      // Every tool call this round was read-only — resolve them all and loop
      // back to Claude without involving the client.
      const resolved = await Promise.all(
        readOnlyCalls.map((b) =>
          safeExecuteReadOnly(b.name, b.input as Record<string, unknown>),
        ),
      );
      if (aborted) return;
      messages.push({
        role: 'user',
        content: readOnlyCalls.map((b, i) => ({
          type: 'tool_result' as const,
          tool_use_id: b.id,
          content: JSON.stringify(resolved[i].content),
          is_error: !resolved[i].ok,
        })),
      });
    }

    send({
      type: 'error',
      message:
        'Too many automatic lookups in a row without resolving — try rephrasing the request.',
    });
  } catch (err) {
    if (!aborted) {
      send({ type: 'error', message: (err as Error).message });
    }
  } finally {
    res.end();
  }
}

// Start a new turn from a natural-language prompt, optionally continuing an
// existing conversation (`messages` holds everything said so far in this
// session — omit it, or send [], to start a fresh conversation).
assistantRouter.post('/plan', async (req: Request, res: Response) => {
  try {
    const { prompt, messages: prior } = req.body as {
      prompt?: string;
      messages?: Anthropic.MessageParam[];
    };
    if (!prompt?.trim()) {
      res.status(400).json({ error: 'A prompt is required.' });
      return;
    }
    const messages: Anthropic.MessageParam[] = [...(prior ?? []), { role: 'user', content: prompt.trim() }];
    await respondStream(messages, req, res);
  } catch (err) {
    // If headers haven't been sent yet, this is a pre-stream error (e.g.
    // body parse failure). Otherwise the error was already sent via SSE.
    if (!res.headersSent) {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

// Continue a plan after the user has confirmed/declined the pending tool
// call(s) and (for confirmed ones) the real Dockyard API has been invoked.
assistantRouter.post('/confirm', async (req: Request, res: Response) => {
  try {
    const { messages, results } = req.body as {
      messages?: Anthropic.MessageParam[];
      results?: { toolUseId: string; ok: boolean; content: unknown }[];
    };
    if (!messages?.length || !results?.length) {
      res.status(400).json({ error: 'messages and results are required.' });
      return;
    }
    messages.push({
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.toolUseId,
        content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? {}),
        is_error: !r.ok,
      })),
    });
    await respondStream(messages, req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

// ---------------------------------------------------------------------------
// Named, persisted Ask Dockyard sessions. `state` is opaque here — the
// client owns its shape (conversation history, action log, pending
// confirmations) and this layer just stores/returns it verbatim.
// ---------------------------------------------------------------------------

/** Ask Claude for a short, friendly title summarizing a conversation. Used
 *  to name a new session instead of truncating the user's first message. Runs
 *  on Haiku (cheap/fast) with a tight token cap; any failure is caught by the
 *  caller, which falls back to the truncated-first-message heuristic. */
assistantRouter.post('/title', async (req: Request, res: Response) => {
  const { prompt, reply } = req.body as { prompt?: string; reply?: string };
  const userText = (prompt || '').trim();
  if (!userText) {
    res.status(400).json({ error: 'A prompt is required.' });
    return;
  }
  try {
    const out = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 24,
      system:
        'Generate a short, descriptive title (3-6 words, title case, no quotes, no trailing punctuation, no emoji) summarizing what the user asked for. Reply with only the title.',
      messages: [
        {
          role: 'user',
          content: `User asked: ${userText}\n\nAssistant replied: ${(reply || '').slice(0, 600)}`,
        },
      ],
    });
    const title = extractText(out.content)
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .slice(0, 80);
    res.json({ name: title || userText.slice(0, 60) });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

function toSessionSummary(r: { id: string; name: string; created_at: string; updated_at: string }) {
  return { id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at };
}

function toSessionFull(r: import('../db.js').AssistantSessionRow) {
  let state: unknown = {};
  try {
    state = JSON.parse(r.state);
  } catch {
    // Corrupt/empty state — fall back to an empty object rather than 500ing.
  }
  return { ...toSessionSummary(r), state };
}

assistantRouter.get('/sessions', (_req: Request, res: Response) => {
  try {
    res.json(listAssistantSessions().map(toSessionSummary));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

assistantRouter.get('/sessions/:id', (req: Request, res: Response) => {
  try {
    const row = getAssistantSession(req.params.id);
    if (!row) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }
    res.json(toSessionFull(row));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

assistantRouter.post('/sessions', (req: Request, res: Response) => {
  try {
    const { name, state } = req.body as { name?: string; state?: unknown };
    if (!name?.trim()) {
      res.status(400).json({ error: 'A session name is required.' });
      return;
    }
    const id = `asn-${Math.random().toString(36).slice(2, 8)}`;
    const row = createAssistantSession(id, name.trim(), JSON.stringify(state ?? {}));
    res.status(201).json(toSessionFull(row));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

assistantRouter.put('/sessions/:id', (req: Request, res: Response) => {
  try {
    const { name, state } = req.body as { name?: string; state?: unknown };
    const row = updateAssistantSession(req.params.id, {
      name: name?.trim() || undefined,
      state: state !== undefined ? JSON.stringify(state) : undefined,
    });
    if (!row) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }
    res.json(toSessionFull(row));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

assistantRouter.delete('/sessions/:id', (req: Request, res: Response) => {
  try {
    const deleted = deleteAssistantSession(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
