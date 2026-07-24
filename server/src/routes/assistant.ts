import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { getAuthUser } from "../auth.js";
import Anthropic from "@anthropic-ai/sdk";
import {
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { docker } from "../docker.js";
import { stripLogHeaders } from "./containers.js";
import {
  listContainerFiles,
  probeContainerEndpoint,
} from "./containers.js";
import {
  listFunctions,
  getFunction,
  listRoutes,
  listAssistantSessions,
  getAssistantSession,
  createAssistantSession,
  updateAssistantSession,
  deleteAssistantSession,
  listAssistantIssues,
  getAssistantIssue,
  createAssistantIssue,
  updateAssistantIssue,
  deleteAssistantIssue,
  clearAssistantIssues,
  countAssistantIssuesByStatus,
  ASSISTANT_ISSUE_STATUSES,
} from "../db.js";
import { sessionRegistry } from "../sessionRunner.js";
import { getS3Client } from "../minio.js";
import { PRESETS } from "../presets.js";
import { listHostBuildPresets } from "./hostBuilds.js";
import { listHostDirectory, readHostTextFile } from "./hostFiles.js";
import {
  DATABASE_ASSISTANT_READ_ONLY_TOOLS,
  DATABASE_ASSISTANT_TOOLS,
  executeDatabaseAssistantReadOnlyTool,
} from "../databaseAssistantTools.js";
import {
  GITHUB_ASSISTANT_READ_ONLY_TOOLS,
  GITHUB_ASSISTANT_TOOLS,
  executeGithubAssistantReadOnlyTool,
} from "../githubAssistantTools.js";

export const assistantRouter = Router();

type AssistantProvider = 'anthropic' | 'deepseek';

function assistantProvider(): AssistantProvider {
  return process.env.ASSISTANT_PROVIDER === 'deepseek' ? 'deepseek' : 'anthropic';
}

/** Resolve the selected provider's credential once at startup. The key is
 * never logged or persisted; Compose mounts the production values as secrets. */
function resolveApiKey(provider: AssistantProvider): string | undefined {
  const envKey = provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : process.env.ANTHROPIC_API_KEY;
  if (envKey) return envKey;
  const candidates = provider === 'deepseek'
    ? [process.env.DEEPSEEK_API_KEY_FILE, '/run/secrets/deepseek_api_key', path.join(os.homedir(), '.deepseek_api_key')]
    : [process.env.ANTHROPIC_API_KEY_FILE, '/run/secrets/anthropic_api_key', path.join(os.homedir(), '.antro')];
  for (const file of candidates) {
    if (!file) continue;
    try {
      const key = fs.readFileSync(file, "utf8").trim();
      if (key) return key;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

const PROVIDER = assistantProvider();
const MAIN_MODEL = PROVIDER === 'deepseek'
  ? process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro'
  : process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
// Use the rolling alias (no dated snapshot suffix) so this keeps working once
// Anthropic retires the specific snapshot it currently points at — pinning to
// a dated snapshot (e.g. claude-haiku-4-5-20251001) causes title generation
// (and any other caller of this constant) to break outright once that
// snapshot reaches its deprecation/retirement date.
const TITLE_MODEL = PROVIDER === 'deepseek'
  ? process.env.DEEPSEEK_TITLE_MODEL || 'deepseek-v4-flash'
  : process.env.ANTHROPIC_TITLE_MODEL || 'claude-haiku-4-5';

const client = new Anthropic({
  apiKey: resolveApiKey(PROVIDER),
  baseURL: PROVIDER === 'deepseek' ? 'https://api.deepseek.com/anthropic' : 'https://api.anthropic.com',
});

const SYSTEM = `You are the Dockyard.ai assistant. You translate a user's natural-language request into tool calls that manage Lambda functions, Gateway routes, containers, Docker images, storage buckets, and saved MySQL/MongoDB connections.

A knowledge base bucket named \`dockyard-knowledge\` holds per-resource markdown notes keyed as \`{type}/{id}.md\` (e.g. \`container/ct-abc123.md\`, \`fn/fn-xyz789.md\`). Before operating on any resource, check whether a note exists at the expected key by calling read_bucket_object. If one exists, read it and factor its contents — especially deploy methodology, gotchas, dependencies, and future plans — into every decision you make about that resource. After making meaningful changes to a resource, offer to update its note. If the dockyard-knowledge bucket exists, protect it with update_bucket so it can't be accidentally deleted. When creating a bucket you expect will hold important data, set protected: true on create_bucket or call update_bucket afterwards.

Rules:
- Briefly describe what you're about to do before calling a tool, so the user can see what's happening. Never invent a resource id.
- If the user names a resource by a friendly name/description rather than an id, and you don't already have that id from the user's message or an earlier tool result, first call the matching list_* tool to look it up (list_containers, list_functions, list_gateway_routes, list_buckets, list_images, list_host_build_presets, list_database_connections — these run automatically, no confirmation needed). If exactly one result matches, use its id. If there's no match or more than one plausible match, ask the user to clarify rather than guessing.
- When the user refers to a resource vaguely ("the function", "it", "that one", "this bucket") without naming it, first check whether an earlier message or tool result in this same conversation already established which one. If exactly one resource was clearly the subject of the recent exchange, use its id directly without re-listing or re-asking. Only fall back to list_* or asking the user to clarify when no such resource is evident from the conversation so far.
- When the user asks what a function does or wants to see its code, call read_function with its id — list_functions only returns id/name/runtime, not the source code. read_function runs automatically (no confirmation needed) and returns the full function details including code, runtime, packages, and entry point.
- Before editing a file that might already exist in a bucket (e.g. "change the title", "add a button", "fix the CSS"), call list_bucket_objects and read_bucket_object first and base the edit on the real current content — never blindly regenerate a file from scratch when the request implies an existing one. write_bucket_object always replaces a file's entire content, so the new content you send must include everything you want kept, not just the changed part.
- The "content"/"code" you send to write_bucket_object, write_bucket_objects, write_container_file, write_container_files, replace_in_bucket_object, replace_in_container_file, and create_lambda_function/update the function's code must be exactly the file's intended contents — nothing else. Never append a closing remark, joke, quip, watermark, or any other extra line/comment that wasn't asked for, especially not to the last line of a JSON, CSS, or other config/code file; a stray trailing phrase can break parsers.
- For multi-step requests (e.g. "create a function and attach a gateway route to it"), call one tool at a time and wait for its real result before calling the next one — never invent an id.
- Default runtime is "node" unless the user names another ("python" or "sh").
- When writing a function's "code", write complete, runnable source for the chosen runtime. Functions invoked through a gateway route follow this contract: the incoming request arrives as JSON in the DOCKYARD_REQUEST environment variable, shaped like { httpMethod, path, headers, queryStringParameters, body, isBase64Encoded } (body may be null). The function must print exactly one JSON object to stdout shaped like { "statusCode": number, "headers"?: object, "body": string, "isBase64Encoded"?: boolean }. Do not print anything else to stdout.
- When a gateway route targets a lambda function, targetType must be \"lambda\" and targetId must be the id returned by the create_lambda_function call. When it targets a bucket, targetType must be \"bucket\" and targetId is simply the bucket's name.\n    - All gateway routes are reachable at /gw/{name} — always tell the user the full URL when confirming a route was created. Critical: the backend receives the request with /gw/ stripped but the route name preserved — /gw/my-site/about → /my-site/about on the backend. When configuring a reverse proxy (nginx, etc.) or SPA, account for the /{name}/ path prefix (base href, asset paths, API endpoint prefixes all need it).
- gateway route "pathPattern" is matched by EXACT string equality against the incoming request path (with the route's own name already stripped from the front) — there is no wildcard, glob, or prefix support. A trailing "/*" or "/:id" will never match anything real; do not use them. To match every path and method under a route (a whole static site, or a REST resource with multiple sub-paths like "/todos" and "/todos/{id}"), omit both "method" and "pathPattern" entirely rather than guessing a pattern.
- A gateway route "name" is a group that can hold multiple method/pathPattern/target combinations — e.g. GET /todos going to one target and POST /todos/{id} going to another, all under the same name. create_gateway_route only accepts one method/pathPattern/targetId combination per call, so build up a multi-endpoint route by calling create_gateway_route once per combination, reusing the same "name" each time (this mirrors the "+ Add endpoint" button in the Gateway UI, which adds one endpoint to an existing named route). Never claim this isn't supported — it is; it just takes one tool call per endpoint, same as any other multi-step request.
- To host a static website on a BUCKET (the default, simplest path): create the bucket first if it doesn't already exist (check with list_buckets), write the files with write_bucket_objects (accepts an array of { key, content } — prefer this bulk form for multi-file sites), then create_gateway_route with targetType "bucket" and targetId set to the bucket name, omitting method and pathPattern so every file in the site is reachable. Requests to "/" or a path with no file extension serve "index.html" (SPA-style fallback). For a quick single-file edit, use replace_in_bucket_object instead of reading and rewriting the whole file.
- To host a site on an OS CONTAINER instead (when the user asks for a container/VM/server, needs a long-running process, dynamic requests, or explicitly wants it on a container rather than a bucket): call launch_container with a serving image — prefer "nginx:alpine" for static sites because its default command serves /usr/share/nginx/html on port 80 with no extra setup. Write the site files with write_container_files (accepts an array of { path, content } — prefer this bulk form), then create_gateway_route with targetType "container", targetId set to the container id returned by launch_container, targetPort 80, omitting method and pathPattern so every path reaches the container. For a quick single-file edit, use replace_in_container_file instead of rewriting the whole file. Use this path only when a container is genuinely wanted; otherwise default to the bucket path.
- When launching a container for builds or development (not a serving container with a real server process), pass command: ["sleep", "infinity"] to launch_container to keep it alive — images like node:22-alpine exit immediately otherwise because their default CMD is just "node" with no script.
- Containers launched through this assistant can run confirmed commands with execute_container_command. Pass command as an argument array, never as a shell string: for example, ["npm", "ci"] or ["npx", "ng", "build"]. Set workingDir when the project is not in the container's default working directory. To start a long-running server (e.g. a Node.js API), set background: true so the command runs detached and doesn't block — the tool returns immediately. IMPORTANT: background execs do NOT capture stdout/stderr; use get_container_logs for the container's primary process output, or run commands non-background to see their output inline. For one-shot commands whose output you need (builds, installs, file listings), always run them non-background. To update environment variables on a running container, use update_container_env — it stops, merges the new vars with existing ones, recreates the container, and starts it again. Pass persist: true to snapshot the writable layer before recreating so runtime files survive. The same tool also accepts a description parameter to add or update the iaas.description label on an already-running container (e.g. one launched before the description feature existed) — pass env, description, or both.
- The host filesystem is available read-only within Dockyard's configured host-files mount. Use list_host_directory to inspect one directory at a time, then read_host_file to read an explicitly requested text file. Both require absolute host paths (for example, "/home/me/project"). Do not read files the user has not requested or that are likely to contain secrets (such as .env files, SSH keys, credential stores, or private keys). Host file reads are capped at 512 KiB and 50,000 characters; binary files cannot be read. To copy one host file to a bucket, use copy_host_file_to_bucket. To copy one host file to a container folder, use copy_host_file_to_container. Both require confirmation and accept the source as its absolute HOST path. Host file transfers support regular files up to 200 MiB.
- To build a configured host project and deploy its artifacts to a container, first call list_host_build_presets to find the exact preset, then call run_host_build_preset with its name, target container id, and destination directory. Presets contain fixed host-side commands and artifact directories; never invent a command, command arguments, working directory, or artifact path.
- For database work, always resolve the saved connection id first (list_database_connections unless it is already known). Use inspect_database_schema to explore structure, run_database_read_query for bounded read-only access, execute_database_mutation for one confirmed write, execute_database_migration for confirmed schema/multi-step changes, execute_database_access_grant for structured MySQL GRANT or MongoDB grantRolesToUser requests, create_database_backup to generate a backup job, restore_database_backup to restore from a prior backup job id, and list_database_jobs / get_database_job to inspect backup or restore history.
- For MySQL reads, run_database_read_query must receive one read-only SQL statement in the sql field. For MongoDB reads, use run_database_read_query with collection plus mode/find/aggregate/count and JSON filter/projection/sort/pipeline fields as needed. Never use execute_database_mutation or execute_database_migration for a read-only request.
- Destructive or disruptive actions (delete_*, prune_*, container_action) still go through the normal tool-call flow — the user reviews and confirms every tool call before it executes, so call the tool directly rather than asking "are you sure?" in text first. write_container_file, write_container_files, write_bucket_objects, replace_in_container_file, replace_in_bucket_object, update_container_env, host-file copies, and launch_container are no exception: call them directly; the user confirms before they run.
- Database writes, migrations, grants, backups, restores, and saved-connection create/update/delete/test actions are also confirmed by the user before client execution, so call the appropriate tool directly instead of asking for a second textual confirmation.
- For GitHub: use list_github_repo_files and read_github_file to browse or read one repo's content (public repos need no token; private repos need a configured GitHub token and fail with a clear error otherwise). When the user wants to pull an ENTIRE repo (not just one file) onto Dockyard, use pull_github_repo_to_bucket (bucket must already exist) or pull_github_repo_to_container (container must be running) — these download the whole repo tree and write every file, preserving folder structure; do not try to read and re-write each file individually for a whole-repo pull. Pass clean: true to delete the destination first, ensuring stale files from a previous pull don't linger. To commit and push changes back to GitHub, use commit_and_push_github_files with the complete new content of every changed file — it clones (or refreshes an existing local clone), commits, and pushes to the given branch (or the repo's default branch); this always requires a configured GitHub token. All four mutating GitHub tools (the two pull tools and commit_and_push_github_files) require user confirmation — call them directly rather than asking a second time in text.
- When you need to pause between polling operations (e.g. waiting for a container to start, a build to finish, a database backup to complete, or a resource to become available), call wait with the number of seconds to pause (1-60) and an optional short reason describing what you're waiting for. The server will sleep for that duration and show a countdown progress bar to the user. This runs automatically with no confirmation needed. When polling the same resource repeatedly, you MUST call wait between every check. Calling the same read-only tool twice within 10 seconds without an intervening wait is forbidden — never fire rapid back-to-back polls of the same tool.
	- Dockyard runs an issue consumer: an auto-fix bot that continuously polls the issue store for open issues, applies Claude Code to diagnose and fix them against this codebase, and pushes the resulting commits to GitHub. When you log an issue via report_issue, the consumer picks it up automatically (usually within seconds). After reporting an issue, proactively mention the consumer and offer to check its progress: call get_consumer_status to see whether the consumer is currently idle or actively working on a specific issue, and get_consumer_activity to review recent fix attempts and their outcomes (including GitHub commit links for successful fixes). If the consumer failed to process an issue (e.g. a timeout or an API error), use retry_issue to re-open it so the consumer picks it up on the next poll cycle. The feedback loop closes when an issue transitions to "resolved" with a linked commit. The user may not realize this happened unless you surface it.
	- When done, give a short (1-2 sentence) confirmation of what was done — no more.`;

const tools: Anthropic.Tool[] = [
  {
    name: "create_lambda_function",
    description:
      "Create a new Lambda-style function in Dockyard.ai. Call this when the user wants to create/define a function.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Function name" },
        runtime: {
          type: "string",
          enum: ["node", "python", "sh"],
          description: "Defaults to node",
        },
        code: {
          type: "string",
          description: "Complete source code for the function's entry file",
        },
        packages: {
          type: "string",
          description: "Space-separated packages to install, if any",
        },
        entryPoint: {
          type: "string",
          description: "Entry filename, e.g. index.js",
        },
      },
      required: ["name", "code"],
    },
  },
  {
    name: "create_gateway_route",
    description:
      'Create an API Gateway route pointing at a target resource. The route will be reachable at /gw/{name}. Important: the backend receives the request with the /gw/ prefix stripped but the route name preserved — e.g. /gw/my-site/about becomes /my-site/about on the backend. Tell the user this so they configure their server/app correctly (e.g. nginx needs to serve from /{name}/..., and SPA base href or asset paths must account for the route name prefix). Call this when the user wants to expose or attach an endpoint. For targetType "lambda", targetId is the id returned by create_lambda_function. For targetType "bucket", targetId is just the bucket name (no lookup needed) — use this to serve a static site written with write_bucket_object. For targetType "container", targetId is the container id returned by launch_container and targetPort is the port the server listens on inside that container (e.g. 80 for nginx) — use this to serve a site hosted on an OS container written with write_container_file.',
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Route name: lowercase letters/digits/hyphens, starting with a letter or digit. This is the URL segment: /gw/{name}.",
        },
        displayName: {
          type: "string",
          description: "Optional human-readable display name shown in the UI instead of the URL slug.",
        },
        targetType: { type: "string", enum: ["lambda", "container", "bucket"] },
        targetId: { type: "string" },
        targetPort: {
          type: "number",
          description:
            'For targetType "container" only: the port the server listens on inside the target container (e.g. 80 for nginx). Omit for lambda/bucket targets.',
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
        },
        pathPattern: {
          type: "string",
          description:
            'Must start with "/". Matched by EXACT string equality against the request path — no wildcards or path params (a trailing "/*" or "/:id" never matches). Omit this (and method) entirely for a catch-all route matching every path/method, which is usually what you want for a bucket-hosted site, a container-hosted site, or a multi-path REST resource.',
        },
      },
      required: ["name", "targetType", "targetId"],
    },
  },
  {
    name: "update_lambda_function",
    description:
      "Update an existing Lambda function's name, runtime, code, packages, entry point, or additional files.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Function id, e.g. fn-abc123" },
        name: { type: "string" },
        runtime: { type: "string", enum: ["node", "python", "sh"] },
        code: { type: "string" },
        packages: {
          type: "string",
          description: "Space-separated packages to install",
        },
        entryPoint: { type: "string" },
        files: {
          type: "array",
          description:
            "Additional function files, excluding the entry point. Replaces the complete additional-file list when provided.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Relative file path" },
              content: { type: "string", description: "Complete file content" },
            },
            required: ["path", "content"],
          },
        },
      },
      required: ["id"],
    },
  },
  {
    name: "replace_lambda_function_files",
    description:
      "Replace the complete source file set of an existing Lambda function. Use this for any code edit that adds, removes, or changes files. The files array must contain the entry point and every additional file that should remain.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Function id, e.g. fn-abc123" },
        entryPoint: {
          type: "string",
          description: "Path of the file to execute",
        },
        files: {
          type: "array",
          description:
            "Complete function file set, including the entry point and every retained additional file.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Relative file path" },
              content: { type: "string", description: "Complete file content" },
            },
            required: ["path", "content"],
          },
        },
      },
      required: ["id", "entryPoint", "files"],
    },
  },
  {
    name: "delete_lambda_function",
    description: "Delete a saved Lambda function by id.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "delete_gateway_route",
    description: "Delete a gateway route by id.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "launch_container",
    description:
      "Launch a new Docker container, either from a named preset or a raw image. Pass command to override the image's default CMD — useful for keeping build images alive with [\"sleep\",\"infinity\"] when they'd otherwise exit immediately.",
    input_schema: {
      type: "object",
      properties: {
        presetId: {
          type: "string",
          description: "A known preset id, if the user named one",
        },
        image: {
          type: "string",
          description:
            'Docker image (e.g. "redis:7-alpine"), if not using a preset',
        },
        name: { type: "string", description: "Container name" },
        description: {
          type: "string",
          description: "Optional free-text note describing the container's purpose, shown in list_containers and inspect_container output.",
        },
        protected: {
          type: "boolean",
          description: "If true, guard this container against accidental start/stop/restart/removal from the UI and assistant (e.g. important long-lived infrastructure like a queue or database). Can be changed later with update_container_env.",
        },
        command: {
          type: "array",
          description: 'Override the default CMD, e.g. ["sleep","infinity"] or ["tail","-f","/dev/null"]. Pass as separate string arguments, not a shell string.',
          items: { type: "string" },
        },
        ports: {
          type: "array",
          description: "Port mappings",
          items: {
            type: "object",
            properties: {
              container: {
                type: "string",
                description: 'Container-side port, e.g. "6379" or "6379/tcp"',
              },
              host: { type: "number", description: "Host-side port" },
            },
            required: ["container", "host"],
          },
        },
        env: {
          type: "array",
          description: "Environment variables",
          items: {
            type: "object",
            properties: { key: { type: "string" }, value: { type: "string" } },
            required: ["key", "value"],
          },
        },
      },
      required: [],
    },
  },
  {
    name: "container_action",
    description: "Start, stop, or restart an existing container.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Container id" },
        action: { type: "string", enum: ["start", "stop", "restart"] },
      },
      required: ["id", "action"],
    },
  },
  {
    name: "write_container_file",
    description:
      'Write (create or overwrite) a text file inside a running container at an absolute path. Use this to host a static site on an OS container: launch a serving image such as nginx:alpine (which serves /usr/share/nginx/html on port 80 by default), write each site file there (e.g. /usr/share/nginx/html/index.html, /usr/share/nginx/html/style.css), then create_gateway_route with targetType "container", targetId set to that container id, and targetPort 80.',
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Container id (from launch_container or list_containers)",
        },
        path: {
          type: "string",
          description:
            'Absolute path inside the container, e.g. "/usr/share/nginx/html/index.html"',
        },
        content: {
          type: "string",
          description: "The file's full text content",
        },
      },
      required: ["id", "path", "content"],
    },
  },
  {
    name: "execute_container_command",
    description:
      'Run a command in a running container that this assistant launched. Requires user confirmation. Pass command as separate arguments, e.g. ["npm", "ci"] or ["npx", "ng", "build"], not a shell command string. Returns combined stdout/stderr and exit code. Use workingDir for the project directory.',
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Container id returned by launch_container",
        },
        command: {
          type: "array",
          description: 'Executable and arguments, e.g. ["npm", "ci"]',
          items: { type: "string" },
        },
        workingDir: {
          type: "string",
          description: 'Optional absolute project directory inside the container, e.g. "/workspace"',
        },
        background: {
          type: "boolean",
          description: 'If true, start the command detached and return immediately. The output is captured in the background and can be retrieved later with get_container_exec_output using the returned execId.',
        },
        timeoutSeconds: {
          type: "number",
          description: 'Optional timeout in seconds (1-600, max 10 min). Command is terminated after this window; partial output is returned.',
        },
      },
      required: ["id", "command"],
    },
  },
  {
    name: "get_container_exec_output",
    description:
      "Retrieve the captured stdout/stderr and exit code from a background exec. Pass the execId returned by a prior execute_container_command call with background:true. Output is buffered and available for 5 minutes after the command finishes.",
    input_schema: {
      type: "object",
      properties: { execId: { type: "string", description: "Exec id from the background execute_container_command result" } },
      required: ["execId"],
    },
  },
  {
    name: "copy_host_file_to_container",
    description:
      "Copy one existing regular file from the host filesystem into a running, non-system container. This copies binary data without reading its contents into the conversation. The user must explicitly name the absolute host source path and the absolute destination path inside the container. Requires user confirmation.",
    input_schema: {
      type: "object",
      properties: {
        sourcePath: {
          type: "string",
          description:
            'Absolute path on the Docker host, e.g. "/home/me/report.pdf"',
        },
        id: {
          type: "string",
          description:
            "Container id (from launch_container or list_containers)",
        },
        path: {
          type: "string",
          description: "Absolute destination file path inside the container",
        },
      },
      required: ["sourcePath", "id", "path"],
    },
  },
  {
    name: "delete_container",
    description: "Remove a container by id.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        force: { type: "boolean", description: "Force-remove even if running" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_image",
    description: "Remove a Docker image by id.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        force: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "prune_images",
    description:
      "Prune unused/dangling Docker images and stopped containers to reclaim disk space. Takes no arguments.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_bucket",
    description:
      "Create a new storage bucket. Pass protected: true to guard against accidental deletion from the UI and assistant (can be changed later with update_bucket).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        protected: {
          type: "boolean",
          description: "If true, guard this bucket against accidental deletion (bucket and its objects). Writes still work normally.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_bucket",
    description:
      "Delete a storage bucket by name. Fails if the bucket is not empty, or if it is protected (unprotect it first with update_bucket).",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "delete_bucket_object",
    description:
      "Delete a single object (file) from a storage bucket. Fails if the bucket is protected (unprotect it first with update_bucket).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Bucket name" },
        key: {
          type: "string",
          description: "Object key/path within the bucket",
        },
      },
      required: ["name", "key"],
    },
  },
  {
    name: "update_bucket",
    description:
      "Toggle the protected flag on a storage bucket. When protected, the bucket and its objects cannot be deleted from the UI or assistant (writes still work normally). Use this to guard important buckets like dockyard-knowledge from accidental deletion.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Bucket name" },
        protected: {
          type: "boolean",
          description: "Set to true to protect the bucket from deletion; false to remove protection.",
        },
      },
      required: ["name", "protected"],
    },
  },
  {
    name: "write_bucket_object",
    description:
      'Write (create or overwrite) a text file in a storage bucket — the bucket must already exist. Use this to build a static website: write "index.html", "style.css", "script.js", etc., one file per call, then create_gateway_route with targetType "bucket" to serve them.',
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Bucket name" },
        key: {
          type: "string",
          description:
            'Object key/path within the bucket, e.g. "index.html" or "assets/style.css"',
        },
        content: {
          type: "string",
          description: "The file's full text content",
        },
        contentType: {
          type: "string",
          description:
            "MIME type, e.g. text/html, text/css, application/javascript, application/json. Defaults to text/plain.",
        },
      },
      required: ["name", "key", "content"],
    },
  },
  {
    name: "copy_host_file_to_bucket",
    description:
      "Copy one existing regular file from the host filesystem into an existing storage bucket. This copies binary data without reading its contents into the conversation. The user must explicitly name the absolute host source path, destination bucket, and destination object key. Requires user confirmation.",
    input_schema: {
      type: "object",
      properties: {
        sourcePath: {
          type: "string",
          description:
            'Absolute path on the Docker host, e.g. "/home/me/report.pdf"',
        },
        bucket: {
          type: "string",
          description: "Existing destination bucket name",
        },
        key: {
          type: "string",
          description: "Destination object key/path in the bucket",
        },
        contentType: {
          type: "string",
          description: "Optional MIME type, e.g. application/pdf",
        },
      },
      required: ["sourcePath", "bucket", "key"],
    },
  },
  {
    name: "list_host_directory",
    description:
      "List the immediate entries in an absolute directory on the read-only host-files mount. Returns up to 500 entries with names, types, sizes for files, and modification times. Use this before reading a host file when the user asks to inspect a directory.",
    input_schema: {
      type: "object",
      properties: {
        sourcePath: {
          type: "string",
          description: 'Absolute host directory path, e.g. "/home/me/project"',
        },
      },
      required: ["sourcePath"],
    },
  },
  {
    name: "read_host_file",
    description:
      "Read the UTF-8 text content of one explicitly requested regular file on the read-only host-files mount. File contents are returned to the conversation. Do not use for binary files or likely secret files. Limited to 512 KiB and 50,000 characters.",
    input_schema: {
      type: "object",
      properties: {
        sourcePath: {
          type: "string",
          description: 'Absolute host file path, e.g. "/home/me/project/package.json"',
        },
      },
      required: ["sourcePath"],
    },
  },
  {
    name: "run_host_build_preset",
    description:
      "Run a named, administrator-configured host build preset and copy its configured artifact directory into a running non-system container. The preset fixes the host command, arguments, working directory, and artifact path; this tool accepts only the preset name, target container id, and destination directory. Requires user confirmation.",
    input_schema: {
      type: "object",
      properties: {
        preset: {
          type: "string",
          description:
            "Configured host build preset name (from list_host_build_presets)",
        },
        id: { type: "string", description: "Target container id" },
        path: {
          type: "string",
          description:
            "Absolute destination directory inside the target container",
        },
      },
      required: ["preset", "id", "path"],
    },
  },
  {
    name: "prune_build_cache",
    description:
      "Prune the Docker build cache to reclaim disk space. Takes no arguments.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_containers",
    description:
      "List all containers (id, name, image, state) — use this to resolve a container the user referred to by name to its id.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_functions",
    description:
      "List all saved Lambda functions (id, name, runtime) — use this to resolve a function's name to its id.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_gateway_routes",
    description:
      "List all gateway routes (id, name, targetType, targetId, method, pathPattern) — use this to resolve a route's name to its id.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_buckets",
    description: "List all storage buckets (name).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_images",
    description:
      "List all Docker images (id, tags) — use this to resolve an image's tag to its id.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_bucket_objects",
    description:
      "List the files (and folder-like prefixes) inside a bucket, optionally under a prefix. Use this before modifying an existing bucket-hosted site to see what files already exist.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Bucket name" },
        prefix: {
          type: "string",
          description: 'Only list keys under this prefix, e.g. "assets/"',
        },
      },
      required: ["name"],
    },
  },
  {
    name: "read_bucket_object",
    description:
      "Read a text file's content from a bucket. Use this before editing an existing file with write_bucket_object, so the edit is based on the real current content rather than a guess.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Bucket name" },
        key: {
          type: "string",
          description: 'Object key/path within the bucket, e.g. "index.html"',
        },
      },
      required: ["name", "key"],
    },
  },
  {
    name: "read_function",
    description:
      "Read a Lambda function's full details including its source code, runtime, packages, and entry point. Use this when the user asks what a function does or wants to see its code — list_functions only returns id/name/runtime, not the code itself.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Function id, e.g. fn-abc123" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_container_logs",
    description:
      "Fetch a container's recent stdout/stderr log output (read-only, runs automatically with no confirmation). Use this when the user asks what a container is doing, why it isn't working, or wants to see its logs. Returns up to `tail` lines (default 200).",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Container id (from list_containers or launch_container)",
        },
        tail: {
          type: "number",
          description: "Number of recent lines to fetch (default 200, max 500)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "inspect_container",
    description:
      "Inspect a container's configuration (read-only, runs automatically with no confirmation): image, state, published ports, volumes, restart policy, and labels. Environment variable VALUES are redacted for safety — only the env var NAMES are returned. Use this when the user asks how a container is configured or what it's running.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Container id" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_presets",
    description:
      "List the launchable image presets (the gallery of quick-start images — analogous to AMIs): each preset has an id, name, category, image, description, suggested ports and env defaults. Use this when the user asks what they can launch or wants to pick a preset to run. Read-only, runs automatically with no confirmation.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_used_ports",
    description:
      "List the host ports currently published by running containers (read-only, runs automatically with no confirmation). Use this before launching a container with a specific host port to avoid a conflict, or when the user asks what ports are in use.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_host_build_presets",
    description:
      "List administrator-configured host build presets. Each preset has a name, fixed command/arguments, host working directory, and artifact directory. Read-only, runs automatically with no confirmation.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "run_function",
    description:
      "Run a saved Lambda function by id and return its stdout, status code, and duration. Use this when the user asks to test or run a function. An optional JSON `payload` is provided to the function as the DOCKYARD_REQUEST environment variable (the gateway contract); omit it for functions that take no request. The function runs with its saved environment variables, the same as the editor Run button and gateway invocations. The user confirms before it runs.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Function id, e.g. fn-abc123" },
        payload: {
          type: "object",
          description:
            "Optional request payload passed to the function as DOCKYARD_REQUEST (JSON)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "update_container_env",
    description:
      "Update (add, change, or merge) environment variables, the description, and/or the protected flag on a container. Stops the container, merges the new env vars with existing ones, recreates the container with the same image/config, and starts it again if it was running. By default, recreating from the image wipes the container's writable filesystem layer. Pass persist: true to snapshot the writable layer first via docker commit — this preserves all runtime files (deployed sites, installed packages, config edits) across the update. Pass description to add or update the iaas.description label on an existing container (pass an empty string to clear it) — use this to retroactively add a description to a container that was launched before one was set. Pass protected: true to guard a container against accidental start/stop/restart/removal from the UI and assistant (pass protected: false to unprotect it again). Provide any combination of env, description, and protected. Requires user confirmation.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Container id" },
        env: {
          type: "array",
          description: "Environment variables to set/update. Optional if only updating description/protected.",
          items: {
            type: "object",
            properties: { key: { type: "string" }, value: { type: "string" } },
            required: ["key", "value"],
          },
        },
        description: {
          type: "string",
          description: "New free-text description to set as the container's iaas.description label. Pass an empty string to clear an existing description.",
        },
        protected: {
          type: "boolean",
          description: "Set to true to protect the container from start/stop/restart/removal (in the UI and via container_action/delete_container); set to false to remove that protection.",
        },
        persist: {
          type: "boolean",
          description: "If true, snapshot the writable filesystem layer before recreating so runtime files survive the update.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "replace_in_container_file",
    description:
      "Search-and-replace literal text in one file inside a running container. Reads the file, replaces all occurrences of the search string with the replacement, and writes it back. Use this instead of raw sed for safer, more discoverable edits. Requires user confirmation.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Container id" },
        path: { type: "string", description: "Absolute file path inside the container" },
        search: { type: "string", description: "Literal string to find (not a regex)" },
        replace: { type: "string", description: "Replacement string" },
      },
      required: ["id", "path", "search", "replace"],
    },
  },
  {
    name: "replace_in_bucket_object",
    description:
      "Search-and-replace literal text in one object (file) inside a storage bucket. Reads the object, replaces all occurrences of the search string with the replacement, and writes it back. Use this instead of reading the whole file and rewriting it. Requires user confirmation.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Bucket name" },
        key: { type: "string", description: "Object key within the bucket" },
        search: { type: "string", description: "Literal string to find (not a regex)" },
        replace: { type: "string", description: "Replacement string" },
      },
      required: ["name", "key", "search", "replace"],
    },
  },
  {
    name: "list_container_files",
    description:
      "Recursively list files in a container directory (read-only, auto-resolved). Uses `find` with a configurable max depth (default 4, max 8). Returns file/directory entries with names, sizes, and modification times. Use this instead of ad-hoc `execute_container_command` with `find` or `ls -R`.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Container id" },
        path: { type: "string", description: "Absolute container path, defaults to /" },
        maxDepth: { type: "number", description: "Max recursion depth (1-8, default 4)" },
      },
      required: ["id"],
    },
  },
  {
    name: "probe_container_endpoint",
    description:
      "Probe an HTTP endpoint inside a running container from Dockyard's own process (same Docker network). Returns the HTTP status code, response headers, and up to 4 KiB of the response body. Use this to check whether a service is up, verify its response, or troubleshoot connectivity — especially when the container lacks curl/wget.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Container id" },
        port: { type: "number", description: "Port inside the container, e.g. 6006" },
        path: { type: "string", description: "Request path, defaults to /" },
        method: { type: "string", enum: ["GET", "HEAD"], description: "HTTP method, defaults to GET" },
      },
      required: ["id", "port"],
    },
  },
  {
    name: "write_container_files",
    description:
      "Write (create or overwrite) multiple text files inside a running container in a single call. Takes an array of { path, content } — each path is an absolute container path. Use this for multi-file site deploys to avoid one round trip per file. Requires user confirmation.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Container id" },
        files: {
          type: "array",
          description: "Files to write",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Absolute container path, e.g. \"/usr/share/nginx/html/index.html\"" },
              content: { type: "string", description: "Complete file content" },
            },
            required: ["path", "content"],
          },
        },
      },
      required: ["id", "files"],
    },
  },
  {
    name: "write_bucket_objects",
    description:
      "Write (create or overwrite) multiple objects in a storage bucket in a single call. Takes an array of { key, content, contentType? }. Use this for multi-file static site deploys to avoid one round trip per file. Requires user confirmation.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Bucket name" },
        objects: {
          type: "array",
          description: "Objects to write",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "Object key/path within the bucket" },
              content: { type: "string", description: "Complete file text content" },
              contentType: { type: "string", description: "Optional MIME type, defaults to text/plain" },
            },
            required: ["key", "content"],
          },
        },
      },
      required: ["name", "objects"],
    },
  },
  {
    name: "report_issue",
    description:
      "Report a bug, error, missing feature, or operational issue. Persists a structured report to the Dockyard issue store so it can be reviewed later. Use this when you encounter an error that prevented you from completing a user request, or when a user explicitly asks you to log an issue. Include a clear summary, a category (bug, error, missing_feature, performance, security, or general), and any relevant contextual details such as the resource ids, tool names, error messages, and reproduction steps.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Short one-line description of the issue" },
        category: {
          type: "string",
          enum: ["bug", "error", "missing_feature", "performance", "security", "general"],
          description: "Issue category",
        },
        details: {
          type: "object",
          description: "Structured details: what happened, expected outcome, relevant resource ids, tool names, error messages, reproduction steps, and any context that helps diagnose the issue.",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "list_issues",
    description:
      "List recently reported issues from the issue store, newest first. Use this to check whether a problem has already been reported before filing a duplicate.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum results (default 20, max 50)" },
        status: {
          type: "string",
          enum: ["open", "in_progress", "resolved", "closed", "wont_fix"],
          description: "If set, only issues with this status are returned. Omit to include all statuses (including resolved/closed).",
        },
      },
      required: [],
    },
  },
  {
    name: "get_issue",
    description:
      "Read one reported issue by id, including its full details.",
    input_schema: {
      type: "object",
      properties: { issueId: { type: "string", description: "Issue id, e.g. iss-abc123" } },
      required: ["issueId"],
    },
  },
  {
    name: "update_issue",
    description:
      "Update a reported issue's status and/or record its resolution. Use this to mark an issue as in progress, resolved, closed, or won't-fix, and to leave an audit trail describing what was done and by whom.",
    input_schema: {
      type: "object",
      properties: {
        issueId: { type: "string", description: "Issue id, e.g. iss-abc123" },
        status: {
          type: "string",
          enum: ["open", "in_progress", "resolved", "closed", "wont_fix"],
          description: "New status for the issue.",
        },
        resolution: {
          type: "string",
          description: "Free-text description of what was done to address the issue. Meaningful for resolved/closed issues.",
        },
        resolvedBy: {
          type: "string",
          description: "Optional — who or what resolved the issue (e.g. a user name, or 'assistant').",
        },
      },
      required: ["issueId"],
    },
  },
  {
    name: "delete_issue",
    description:
      "Permanently delete one reported issue by id. Use this to clear a single issue once it has been resolved or is no longer relevant.",
    input_schema: {
      type: "object",
      properties: { issueId: { type: "string", description: "Issue id, e.g. iss-abc123" } },
      required: ["issueId"],
    },
  },
  {
    name: "clear_issues",
    description:
      "Bulk-delete reported issues from the issue store, e.g. to clear out everything once it has been triaged/resolved. Optionally restrict to a single category; omit to clear all issues visible to the current user.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["bug", "error", "missing_feature", "performance", "security", "general"],
          description: "If set, only issues in this category are deleted. Omit to clear all issues.",
        },
      },
      required: [],
    },
  },
  {
    name: "wait",
    description:
      "Pause between polling operations to avoid hammering the API. Call this when you need to wait before checking again — for example, waiting for a container to start, a build to finish, a database backup to complete, or any resource to become available. The server will sleep for the requested number of seconds and show a countdown progress bar to the user. Runs automatically with no confirmation needed.",
    input_schema: {
      type: "object",
      properties: {
        seconds: {
          type: "number",
          description:
            "Number of seconds to wait (1-60). The server clamps values outside this range.",
        },
        reason: {
          type: "string",
          description:
            "Optional short reason shown to the user during the countdown, e.g. 'container starting' or 'build in progress'.",
        },
      },
      required: ["seconds"],
    },
  },
  {
    name: "get_consumer_status",
    description: "Check the current status of the Dockyard issue consumer. Returns idle, processing (with issue details), errored, or no-auth. Use this to see what the consumer is doing right now.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_consumer_activity",
    description: "List recent consumer activity — which issues were processed, the outcome (fixed/failed), and links to GitHub commits. Returns up to 10 recent entries.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max entries to return (1-20, default 10)" },
      },
      required: [],
    },
  },
  {
    name: "retry_issue",
    description: "Re-open an issue so the consumer picks it up again. Use when the consumer failed to process an issue and you want to retry.",
    input_schema: {
      type: "object",
      properties: {
        issueId: { type: "string", description: "The issue ID to retry" },
      },
      required: ["issueId"],
    },
  },
  {
    name: "check_consumer_health",
    description: "Run a full health check on the consumer: status file, DB access, API reachability, Claude availability, git config. Returns pass/fail for each.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  ...DATABASE_ASSISTANT_TOOLS,
  ...GITHUB_ASSISTANT_TOOLS,
];

/** These tools have no side effects, so the server executes them itself and
 *  loops back to Claude immediately — the client never sees them and never
 *  has to confirm a plain lookup. */
const READ_ONLY_TOOLS = new Set([
  "list_containers",
  "list_functions",
  "list_gateway_routes",
  "list_buckets",
  "list_images",
  "list_bucket_objects",
  "read_bucket_object",
  "read_function",
  "get_container_logs",
  "inspect_container",
  "list_presets",
  "list_used_ports",
  "list_host_build_presets",
  "list_host_directory",
  "read_host_file",
  "list_container_files",
  "probe_container_endpoint",
  "get_container_exec_output",
  "list_issues",
  "get_issue",
  "get_consumer_status",
  "get_consumer_activity",
  "check_consumer_health",
  ...DATABASE_ASSISTANT_READ_ONLY_TOOLS,
  ...GITHUB_ASSISTANT_READ_ONLY_TOOLS,
]);

/** Caps how much of a bucket object's content gets fed back to Claude — a
 *  multi-MB asset would otherwise blow up the conversation's token count. */
const MAX_OBJECT_READ_CHARS = 50_000;

async function streamToString(body: unknown): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function executeReadOnlyTool(
  name: string,
  input: Record<string, unknown>,
  userId?: string,
): Promise<unknown> {
  switch (name) {
    case "list_containers": {
      const list = await docker.listContainers({ all: true });
      return list.map((c) => ({
        id: c.Id,
        name: (c.Names?.[0] || "").replace(/^\//, ""),
        image: c.Image,
        state: c.State,
        description: c.Labels?.["iaas.description"] || undefined,
        protected: !!c.Labels?.["iaas.protected"],
      }));
    }
    case "list_functions":
      return listFunctions().map((f) => ({
        id: f.id,
        name: f.name,
        runtime: f.runtime,
      }));
    case "list_gateway_routes":
      return listRoutes().map((r) => ({
        id: r.id,
        name: r.name,
        targetType: r.target_type,
        targetId: r.target_id,
        method: r.method,
        pathPattern: r.path_pattern,
      }));
    case "list_buckets": {
      const out = await getS3Client().send(new ListBucketsCommand({}));
      const { isBucketProtected } = await import("../db.js");
      return (out.Buckets || []).map((b) => ({ name: b.Name, protected: isBucketProtected(b.Name!) }));
    }
    case "list_images": {
      const list = await docker.listImages();
      return list.map((img) => ({ id: img.Id, tags: img.RepoTags || [] }));
    }
    case "list_bucket_objects": {
      const prefix = typeof input.prefix === "string" ? input.prefix : "";
      const out = await getS3Client().send(
        new ListObjectsV2Command({
          Bucket: String(input.name ?? ""),
          Prefix: prefix,
          Delimiter: "/",
        }),
      );
      return {
        prefixes: (out.CommonPrefixes || [])
          .map((p) => p.Prefix)
          .filter(Boolean),
        objects: (out.Contents || [])
          .filter((o) => o.Key !== prefix)
          .map((o) => ({
            key: o.Key,
            size: o.Size ?? 0,
            lastModified: o.LastModified,
          })),
      };
    }
    case "read_bucket_object": {
      const out = await getS3Client().send(
        new GetObjectCommand({
          Bucket: String(input.name ?? ""),
          Key: String(input.key ?? ""),
        }),
      );
      const content = await streamToString(out.Body);
      const truncated = content.length > MAX_OBJECT_READ_CHARS;
      return {
        contentType: out.ContentType,
        content: truncated ? content.slice(0, MAX_OBJECT_READ_CHARS) : content,
        truncated,
      };
    }
    case "read_function": {
      const fn = getFunction(String(input.id ?? ""));
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
    case "get_container_logs": {
      const id = String(input.id ?? "");
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
    case "inspect_container": {
      const info = await docker.getContainer(String(input.id ?? "")).inspect();
      // Env VALUES may contain secrets — return only the variable NAMES, never
      // the values, per secrets hygiene.
      const envNames = (info.Config?.Env || []).map((e) => e.split("=")[0]);
      return {
        id: info.Id,
        name: (info.Name || "").replace(/^\//, ""),
        image: info.Config?.Image ?? "",
        state: info.State?.Status ?? "unknown",
        ports: info.NetworkSettings?.Ports
          ? Object.entries(info.NetworkSettings.Ports).flatMap(
              ([key, bindings]) => {
                const [port, proto] = key.split("/");
                return (bindings || []).map((b) => ({
                  privatePort: Number(port),
                  publicPort: b?.HostPort ? Number(b.HostPort) : undefined,
                  type: proto || "tcp",
                }));
              },
            )
          : [],
        env: envNames,
        volumes: (info.Mounts || []).map((m) => ({
          source: m.Source ?? "",
          destination: m.Destination ?? "",
          type: m.Type ?? "volume",
        })),
        restartPolicy: info.HostConfig?.RestartPolicy?.Name ?? "no",
        labels: info.Config?.Labels ?? {},
        description: info.Config?.Labels?.["iaas.description"] || undefined,
        protected: !!info.Config?.Labels?.["iaas.protected"],
      };
    }
    case "list_presets":
      return PRESETS.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        image: p.image,
        description: p.description,
        ports: (p.ports || []).map((pp) => ({
          container: pp.container,
          host: pp.host,
        })),
      }));
    case "list_used_ports": {
      const list = await docker.listContainers({ all: true });
      const used = new Set<number>();
      for (const c of list) {
        for (const p of c.Ports || []) {
          if (p.PublicPort) used.add(p.PublicPort);
        }
      }
      return { ports: Array.from(used).sort((a, b) => a - b) };
    }
    case "list_host_build_presets": {
      return listHostBuildPresets().map(
        ({ name, cwd, command, args, artifacts }) => ({
          name,
          cwd,
          command,
          args,
          artifacts,
        }),
      );
    }
    case "list_host_directory":
      return listHostDirectory(input.sourcePath);
    case "read_host_file":
      return readHostTextFile(input.sourcePath);
    case "list_issues": {
      const limitRaw = Number(input.limit);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.trunc(limitRaw))) : 20;
      const status = typeof input.status === "string" ? input.status : undefined;
      return listAssistantIssues(limit, userId, status).map(toIssueSummary);
    }
    case "get_issue": {
      const row = getAssistantIssue(String(input.issueId ?? ""), userId);
      if (!row) return { error: `Issue "${input.issueId}" not found.` };
      return toIssueSummary(row);
    }
    case "get_consumer_status": {
      const statusPath = path.join(process.cwd(), "scripts", "issue-logs", "consumer-status.json");
      try {
        const raw = fs.readFileSync(statusPath, "utf8");
        return JSON.parse(raw);
      } catch {
        return { state: "unknown", error: "Status file not found — consumer may not have started yet." };
      }
    }
    case "get_consumer_activity": {
      const logDir = path.join(process.cwd(), "scripts", "issue-logs");
      const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 20);
      try {
        const files = fs.readdirSync(logDir)
          .filter(f => f.endsWith(".md"))
          .sort()
          .reverse()
          .slice(0, limit);
        return files.map(f => {
          const content = fs.readFileSync(path.join(logDir, f), "utf8");
          const exitMatch = content.match(/\*\*Exit code:\*\* (\d+)/);
          const summaryMatch = content.match(/\*\*Summary:\*\* (.+)/);
          const idMatch = content.match(/# Issue (.+)/);
          const commitMatch = content.match(/^commit: ([a-f0-9]+)$/m);
          const outcome = exitMatch ? (exitMatch[1] === "0" ? "fixed" : "failed") : "unknown";
          const entry: Record<string, unknown> = {
            id: idMatch?.[1]?.trim() || f,
            summary: summaryMatch?.[1]?.trim() || "unknown",
            exitCode: exitMatch ? parseInt(exitMatch[1]) : null,
            outcome,
          };
          if (commitMatch) {
            entry.commitSha = commitMatch[1];
            entry.commitUrl = `https://github.com/miltonejones/docker-iaas/commit/${commitMatch[1]}`;
          }
          return entry;
        });
      } catch {
        return [];
      }
    }
    case "check_consumer_health": {
      const results: Record<string, unknown> = {};
      const { execSync } = await import("node:child_process");
      // status file
      const sp = path.join(process.cwd(), "scripts", "issue-logs", "consumer-status.json");
      try { results.status = JSON.parse(fs.readFileSync(sp, "utf8")); } catch { results.status = { state: "unknown" }; }
      // db
      try {
        const db = path.join(process.cwd(), "data", "iaas.db");
        fs.accessSync(db, fs.constants.R_OK);
        results.db = { ok: true, size: fs.statSync(db).size };
      } catch { results.db = { ok: false }; }
      // api
      try {
        const r = await fetch(`http://127.0.0.1:${process.env.PORT || 4300}/api/auth/me`, { signal: AbortSignal.timeout(3000) });
        results.api = { reachable: true, status: r.status };
      } catch { results.api = { reachable: false }; }
      // claude
      try {
        results.claude = { path: execSync("command -v claude || which claude 2>/dev/null || echo not-found", { encoding: "utf8", timeout: 3000 }).trim() };
      } catch { results.claude = { path: "not-found" }; }
      // git
      try {
        execSync("git -C . log --oneline -1 2>/dev/null", { encoding: "utf8", timeout: 3000 });
        results.git = { ok: true };
      } catch { results.git = { ok: false }; }
      return results;
    }
    case "list_container_files":
      return listContainerFiles(
        String(input.id ?? ""),
        typeof input.path === "string" ? input.path : undefined,
        typeof input.maxDepth === "number" ? input.maxDepth : undefined,
      );
    case "probe_container_endpoint":
      return probeContainerEndpoint(
        String(input.id ?? ""),
        typeof input.port === "number" ? input.port : Number(input.port) || 80,
        typeof input.path === "string" ? input.path : undefined,
        typeof input.method === "string" ? input.method : undefined,
      );
    case "get_container_exec_output": {
      const execId = String(input.execId ?? "");
      const url = `http://127.0.0.1:${process.env.PORT || 4300}/api/containers/execs/${encodeURIComponent(execId)}/output`;
      const http = await import("node:http");
      return new Promise((resolve, reject) => {
        http.get(url, (hres) => {
          let data = "";
          hres.on("data", (c: string) => data += c);
          hres.on("end", () => {
            try { resolve(JSON.parse(data)); }
            catch { reject(new Error(`Failed to parse exec output response`)); }
          });
        }).on("error", reject);
      });
    }
    default:
      if (DATABASE_ASSISTANT_READ_ONLY_TOOLS.has(name)) {
        return executeDatabaseAssistantReadOnlyTool(name, input);
      }
      if (GITHUB_ASSISTANT_READ_ONLY_TOOLS.has(name)) {
        return executeGithubAssistantReadOnlyTool(name, input);
      }
      throw new Error(`Unknown read-only tool "${name}".`);
  }
}

async function safeExecuteReadOnly(
  name: string,
  input: Record<string, unknown>,
  userId?: string,
): Promise<{ ok: boolean; content: unknown }> {
  try {
    return { ok: true, content: await executeReadOnlyTool(name, input, userId) };
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
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

const MAX_AUTO_ROUNDS = 8;

/** Thin SSE wrapper around streamTurn for the old /plan and /confirm endpoints. */
async function respondStream(
  messages: Anthropic.MessageParam[],
  req: Request,
  res: Response,
): Promise<void> {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.status(200);

  const send = (data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  await streamTurn(messages, (e) => {
    if (e.type === "text") send({ type: "text", delta: e.delta });
    else if (e.type === "turn") send(e as unknown as Record<string, unknown>);
    else if (e.type === "error") send({ type: "error", error: e.error });
    else if (e.type === "wait") send({ type: "wait", seconds: e.seconds, reason: e.reason, toolUseId: e.toolUseId });
  });
  res.end();
}

// Start a new turn from a natural-language prompt, optionally continuing an
// existing conversation (`messages` holds everything said so far in this
// session — omit it, or send [], to start a fresh conversation).
assistantRouter.post("/plan", async (req: Request, res: Response) => {
  try {
    const { prompt, messages: prior } = req.body as {
      prompt?: string;
      messages?: Anthropic.MessageParam[];
    };
    if (!prompt?.trim()) {
      res.status(400).json({ error: "A prompt is required." });
      return;
    }
    const messages: Anthropic.MessageParam[] = [
      ...(prior ?? []),
      { role: "user", content: prompt.trim() },
    ];
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
assistantRouter.post("/confirm", async (req: Request, res: Response) => {
  try {
    const { messages, results } = req.body as {
      messages?: Anthropic.MessageParam[];
      results?: { toolUseId: string; ok: boolean; content: unknown }[];
    };
    if (!messages?.length || !results?.length) {
      res.status(400).json({ error: "messages and results are required." });
      return;
    }
    messages.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.toolUseId,
        content:
          typeof r.content === "string"
            ? r.content
            : JSON.stringify(r.content ?? {}),
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
assistantRouter.post("/title", async (req: Request, res: Response) => {
  const { prompt, reply } = req.body as { prompt?: string; reply?: string };
  const userText = (prompt || "").trim();
  if (!userText) {
    res.status(400).json({ error: "A prompt is required." });
    return;
  }
  try {
    let title: string | null = null;

    if (PROVIDER === 'deepseek') {
      const deepseekRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolveApiKey('deepseek')}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          max_tokens: 32,
          messages: [
            {
              role: 'user',
              content: `Summarize this conversation in 3-6 words, title case, no quotes or punctuation:\n\nUser: ${userText}\nAssistant: ${(reply || "").slice(0, 600)}`,
            },
          ],
        }),
      });
      const body = await deepseekRes.json() as { choices?: { message?: { content?: string } }[] };
      title = body.choices?.[0]?.message?.content?.trim() ?? null;
    } else {
      const out = await client.messages.create({
        model: TITLE_MODEL,
        max_tokens: 32,
        system: "Generate a short, descriptive title summarizing what the user asked for. Reply with only the title.",
        messages: [
          {
            role: "user",
            content: `User asked: ${userText}\n\nAssistant replied: ${(reply || "").slice(0, 600)}`,
          },
        ],
      });
      title = extractText(out.content).replace(/\s+/g, " ").trim().slice(0, 80);
    }

    res.json({ name: title || userText.slice(0, 60) });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

function toIssueSummary(r: import("../db.js").AssistantIssueRow) {
  let details: unknown = {};
  try { details = JSON.parse(r.details_json); } catch { /* ok */ }
  return {
    id: r.id,
    summary: r.summary,
    category: r.category,
    details,
    createdAt: r.created_at,
    status: r.status,
    resolution: r.resolution,
    resolvedBy: r.resolved_by,
  };
}

function toSessionSummary(r: {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    running: sessionRegistry.has(r.id) && (sessionRegistry.get(r.id)?.isRunning ?? false),
  };
}

function toSessionFull(r: import("../db.js").AssistantSessionRow) {
  let state: unknown = {};
  try {
    state = JSON.parse(r.state);
  } catch {
    // Corrupt/empty state — fall back to an empty object rather than 500ing.
  }
  return { ...toSessionSummary(r), state };
}

assistantRouter.get("/sessions", (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    res.json(listAssistantSessions(userId, q).map(toSessionSummary));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

assistantRouter.get("/sessions/:id", (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const row = getAssistantSession(req.params.id, userId);
    if (!row) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    res.json(toSessionFull(row));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

assistantRouter.post("/sessions", (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const { name, state } = req.body as { name?: string; state?: unknown };
    if (!name?.trim()) {
      res.status(400).json({ error: "A session name is required." });
      return;
    }
    const id = `asn-${Math.random().toString(36).slice(2, 8)}`;
    const row = createAssistantSession(
      id,
      name.trim(),
      JSON.stringify(state ?? {}),
      userId,
    );
    res.status(201).json(toSessionFull(row));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

assistantRouter.put("/sessions/:id", (req: Request, res: Response) => {
  try {
    const { name, state } = req.body as { name?: string; state?: unknown };
    const row = updateAssistantSession(req.params.id, {
      name: name?.trim() || undefined,
      state: state !== undefined ? JSON.stringify(state) : undefined,
    });
    if (!row) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    res.json(toSessionFull(row));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

assistantRouter.delete("/sessions/:id", (req: Request, res: Response) => {
  try {
    const deleted = deleteAssistantSession(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Assistant issue reporting
// ---------------------------------------------------------------------------

assistantRouter.get("/issues/counts", (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const byStatus = countAssistantIssuesByStatus(userId);
    res.json({
      open: byStatus.open ?? 0,
      resolved: (byStatus.resolved ?? 0) + (byStatus.closed ?? 0),
      byStatus,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

assistantRouter.get("/issues", (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    res.json(listAssistantIssues(limit, userId, status).map(toIssueSummary));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

assistantRouter.get("/issues/:id", (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const row = getAssistantIssue(req.params.id, userId);
    if (!row) {
      res.status(404).json({ error: "Issue not found." });
      return;
    }
    res.json(toIssueSummary(row));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

assistantRouter.post("/issues", (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const { summary, category, details } = req.body as {
      summary?: string;
      category?: string;
      details?: Record<string, unknown>;
    };
    if (!summary?.trim()) {
      res.status(400).json({ error: "A summary is required." });
      return;
    }
    const { row } = createAssistantIssue(
      { summary: summary.trim(), category, details },
      userId,
    );
    const payload = toIssueSummary(row);

    // Fire-and-forget webhook so external consumers (Redis queues, Slack, etc.)
    // can react in real time without the assistant needing to call both
    // report_issue and the push endpoint manually.
    const webhookUrl = process.env.ISSUE_WEBHOOK_URL;
    if (webhookUrl) {
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: payload.id, summary: payload.summary, category: payload.category, details: payload.details }),
      }).catch(() => { /* best-effort */ });
    }

    res.status(201).json(payload);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

assistantRouter.delete("/issues/:id", (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const deleted = deleteAssistantIssue(req.params.id, userId);
    if (!deleted) {
      res.status(404).json({ error: "Issue not found." });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

assistantRouter.patch("/issues/:id", (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const { status, resolution, resolvedBy, summary, details } = req.body as {
      status?: string;
      resolution?: string;
      resolvedBy?: string;
      summary?: string;
      details?: Record<string, unknown>;
    };
    if (status !== undefined && !ASSISTANT_ISSUE_STATUSES.includes(status as (typeof ASSISTANT_ISSUE_STATUSES)[number])) {
      res.status(400).json({ error: `Invalid status. Must be one of: ${ASSISTANT_ISSUE_STATUSES.join(", ")}.` });
      return;
    }
    const row = updateAssistantIssue(req.params.id, {
      status, resolution, resolvedBy,
      summary,
      details_json: details !== undefined ? JSON.stringify(details) : undefined,
    }, userId);
    if (!row) {
      res.status(404).json({ error: "Issue not found." });
      return;
    }
    res.json(toIssueSummary(row));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

assistantRouter.delete("/issues", (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    const count = clearAssistantIssues(userId, category);
    res.json({ ok: true, deleted: count });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Session Runner endpoints ─────────────────────────────────────────────────
import { getOrCreateSession, type SessionEvent } from "../sessionRunner.js";

/** Refactored streaming: writes events to a callback instead of directly to `res`.
 *  Used by both the old HTTP endpoints (via respondStream wrapper) and the new
 *  SessionRunner. */
async function streamTurn(
  messages: Anthropic.MessageParam[],
  onEvent: (e: SessionEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let aborted = false;
  const onAbort = () => { aborted = true; };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (let round = 0; round < MAX_AUTO_ROUNDS; round++) {
      if (aborted) return;

      const stream = client.messages.stream({
        model: MAIN_MODEL,
        max_tokens: 32000,
        system: SYSTEM,
        tools,
        messages,
      });

      stream.on("text", (delta) => {
        if (!aborted) onEvent({ type: "text", delta });
      });

      let finalMessage: Anthropic.Message;
      try {
        finalMessage = await stream.finalMessage();
      } catch (err) {
        if (aborted) return;
        throw err;
      }
      if (aborted) return;

      messages.push({ role: "assistant", content: finalMessage.content });

      const toolUses = finalMessage.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      // Handle `wait` tool calls before any other tool processing: emit an
      // SSE wait event so the client shows a countdown, sleep for the
      // requested duration, then add a synthetic tool_result so the model
      // sees the wait as completed.  Wait calls run sequentially (not in
      // parallel) so multiple waits stack their sleep time.
      const waitCalls = toolUses.filter((b) => b.name === "wait");
      if (waitCalls.length > 0) {
        for (const w of waitCalls) {
          const input = w.input as Record<string, unknown>;
          const seconds = Math.max(1, Math.min(60, Number(input.seconds) || 10));
          const reason = typeof input.reason === "string" ? input.reason : undefined;
          onEvent({ type: "wait", seconds, reason, toolUseId: w.id });
          await new Promise((r) => setTimeout(r, seconds * 1000));
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result" as const,
                tool_use_id: w.id,
                content: JSON.stringify({ waited: seconds, reason: reason ?? null }),
              },
            ],
          });
        }
      }

      // Filter out wait calls — they have already been handled above.
      const activeTools = toolUses.filter((b) => b.name !== "wait");
      if (waitCalls.length > 0 && activeTools.length === 0) {
        // Wait was the only tool call — loop back to the model.
        continue;
      }

      const readOnlyCalls = activeTools.filter((b) => READ_ONLY_TOOLS.has(b.name));
      const mutatingCalls = activeTools.filter(
        (b) => !READ_ONLY_TOOLS.has(b.name),
      );

      if (activeTools.length === 0) {
        onEvent({
          type: "turn",
          messages,
          pending: [],
          autoResolved: [],
          done: true,
          text: extractText(finalMessage.content),
        });
        return;
      }

      if (mutatingCalls.length > 0) {
        const autoResolved: ResolvedResult[] = await Promise.all(
          readOnlyCalls.map(async (b) => {
            const r = await safeExecuteReadOnly(b.name, b.input as Record<string, unknown>);
            return { toolUseId: b.id, ok: r.ok, content: r.content };
          }),
        );
        onEvent({
          type: "turn",
          messages,
          pending: mutatingCalls.map((b) => ({ id: b.id, name: b.name, input: b.input })),
          autoResolved,
          done: false,
          text: extractText(finalMessage.content),
        });
        return;
      }

      // All tools are read-only — execute inline and loop.
      const results = await Promise.all(
        readOnlyCalls.map(async (b) => {
          const r = await safeExecuteReadOnly(b.name, b.input as Record<string, unknown>);
          return {
            type: "tool_result" as const,
            tool_use_id: b.id,
            content: typeof r.content === "string" ? r.content : JSON.stringify(r.content ?? {}),
            is_error: !r.ok,
          };
        }),
      );
      messages.push({ role: "user", content: results });
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** SSE subscription — streams live session events to one client. */
assistantRouter.get("/sessions/:id/stream", (req: Request, res: Response) => {
  const userId = getAuthUser(req)?.userId;
  const sessionId = req.params.id;

  // Load the session from DB to get its name
  const row = getAssistantSession(sessionId, userId);
  if (!row) {
    res.status(404).json({ error: "Session not found." });
    return;
  }

  const runner = getOrCreateSession(sessionId, row.name, userId, streamTurn, client);

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.status(200);

  const send = (data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Send current state as catch-up
  const current = getAssistantSession(sessionId, userId);
  if (current) {
    send({ type: "state", ...JSON.parse(current.state) });
  }
  send({ type: "status", running: runner.isRunning });

  // Subscribe to live events
  const onEvent = (e: SessionEvent) => { send(e as unknown as Record<string, unknown>); };

  runner.on("event", onEvent);

  const onClose = () => {
    runner.off("event", onEvent);
  };
  res.on("close", onClose);
});

/** Send a user message (and optional tool results) to a session. */
assistantRouter.post("/sessions/:id/send", async (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const sessionId = req.params.id;
    const { prompt, results: toolResults, state } = req.body as {
      prompt?: string;
      results?: { toolUseId: string; ok: boolean; content: unknown }[];
      state?: { messages: unknown[]; log: unknown[]; pending: unknown[]; resolved: unknown[] };
    };

    if (!prompt?.trim() && !toolResults?.length) {
      res.status(400).json({ error: "A prompt or tool results are required." });
      return;
    }

    const row = getAssistantSession(sessionId, userId);
    if (!row) {
      res.status(404).json({ error: "Session not found." });
      return;
    }

    const runner = getOrCreateSession(sessionId, row.name, userId, streamTurn, client);

    // Start processing in the background — client subscribes via /stream.
    const sessionState = state || JSON.parse(row.state);
    runner.send(sessionState, prompt?.trim() || undefined, toolResults);

    // Persist the updated state immediately
    if (state) {
      updateAssistantSession(sessionId, { state: JSON.stringify(state) });
    }

    res.json({ ok: true, sessionId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Abort the current turn in a session. */
assistantRouter.post("/sessions/:id/abort", (req: Request, res: Response) => {
  const runner = sessionRegistry.get(req.params.id);
  if (runner) runner.abort();
  res.json({ ok: true });
});

// Consumer status — reads the JSON file the consumer writes on every poll cycle.
assistantRouter.get("/consumer/status", (_req: Request, res: Response) => {
  try {
    const statusPath = path.join(process.cwd(), "scripts", "issue-logs", "consumer-status.json");
    if (!fs.existsSync(statusPath)) {
      res.json({ state: "unknown", error: "Status file not found." });
      return;
    }
    const raw = fs.readFileSync(statusPath, "utf8");
    res.json(JSON.parse(raw));
  } catch (err) {
    res.status(500).json({ state: "unknown", error: String(err) });
  }
});
