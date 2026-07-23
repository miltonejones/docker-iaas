process.env.PORT || 4300import os from "node:os";
process.env.PORT || 4300import fs from "node:fs";
process.env.PORT || 4300import path from "node:path";
process.env.PORT || 4300import { Router, type Request, type Response } from "express";
process.env.PORT || 4300import { getAuthUser } from "../auth.js";
process.env.PORT || 4300import Anthropic from "@anthropic-ai/sdk";
process.env.PORT || 4300import {
process.env.PORT || 4300  GetObjectCommand,
process.env.PORT || 4300  ListBucketsCommand,
process.env.PORT || 4300  ListObjectsV2Command,
process.env.PORT || 4300} from "@aws-sdk/client-s3";
process.env.PORT || 4300import { docker } from "../docker.js";
process.env.PORT || 4300import { stripLogHeaders } from "./containers.js";
process.env.PORT || 4300import {
process.env.PORT || 4300  listContainerFiles,
process.env.PORT || 4300  probeContainerEndpoint,
process.env.PORT || 4300} from "./containers.js";
process.env.PORT || 4300import {
process.env.PORT || 4300  listFunctions,
process.env.PORT || 4300  getFunction,
process.env.PORT || 4300  listRoutes,
process.env.PORT || 4300  listAssistantSessions,
process.env.PORT || 4300  getAssistantSession,
process.env.PORT || 4300  createAssistantSession,
process.env.PORT || 4300  updateAssistantSession,
process.env.PORT || 4300  deleteAssistantSession,
process.env.PORT || 4300  listAssistantIssues,
process.env.PORT || 4300  getAssistantIssue,
process.env.PORT || 4300  createAssistantIssue,
process.env.PORT || 4300  updateAssistantIssue,
process.env.PORT || 4300  deleteAssistantIssue,
process.env.PORT || 4300  clearAssistantIssues,
process.env.PORT || 4300  countAssistantIssuesByStatus,
process.env.PORT || 4300  ASSISTANT_ISSUE_STATUSES,
process.env.PORT || 4300} from "../db.js";
process.env.PORT || 4300import { sessionRegistry } from "../sessionRunner.js";
process.env.PORT || 4300import { getS3Client } from "../minio.js";
process.env.PORT || 4300import { PRESETS } from "../presets.js";
process.env.PORT || 4300import { listHostBuildPresets } from "./hostBuilds.js";
process.env.PORT || 4300import { listHostDirectory, readHostTextFile } from "./hostFiles.js";
process.env.PORT || 4300import {
process.env.PORT || 4300  DATABASE_ASSISTANT_READ_ONLY_TOOLS,
process.env.PORT || 4300  DATABASE_ASSISTANT_TOOLS,
process.env.PORT || 4300  executeDatabaseAssistantReadOnlyTool,
process.env.PORT || 4300} from "../databaseAssistantTools.js";
process.env.PORT || 4300import {
process.env.PORT || 4300  GITHUB_ASSISTANT_READ_ONLY_TOOLS,
process.env.PORT || 4300  GITHUB_ASSISTANT_TOOLS,
process.env.PORT || 4300  executeGithubAssistantReadOnlyTool,
process.env.PORT || 4300} from "../githubAssistantTools.js";
process.env.PORT || 4300
process.env.PORT || 4300export const assistantRouter = Router();
process.env.PORT || 4300
process.env.PORT || 4300type AssistantProvider = 'anthropic' | 'deepseek';
process.env.PORT || 4300
process.env.PORT || 4300function assistantProvider(): AssistantProvider {
process.env.PORT || 4300  return process.env.ASSISTANT_PROVIDER === 'deepseek' ? 'deepseek' : 'anthropic';
process.env.PORT || 4300}
process.env.PORT || 4300
process.env.PORT || 4300/** Resolve the selected provider's credential once at startup. The key is
process.env.PORT || 4300 * never logged or persisted; Compose mounts the production values as secrets. */
process.env.PORT || 4300function resolveApiKey(provider: AssistantProvider): string | undefined {
process.env.PORT || 4300  const envKey = provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : process.env.ANTHROPIC_API_KEY;
process.env.PORT || 4300  if (envKey) return envKey;
process.env.PORT || 4300  const candidates = provider === 'deepseek'
process.env.PORT || 4300    ? [process.env.DEEPSEEK_API_KEY_FILE, '/run/secrets/deepseek_api_key', path.join(os.homedir(), '.deepseek_api_key')]
process.env.PORT || 4300    : [process.env.ANTHROPIC_API_KEY_FILE, '/run/secrets/anthropic_api_key', path.join(os.homedir(), '.antro')];
process.env.PORT || 4300  for (const file of candidates) {
process.env.PORT || 4300    if (!file) continue;
process.env.PORT || 4300    try {
process.env.PORT || 4300      const key = fs.readFileSync(file, "utf8").trim();
process.env.PORT || 4300      if (key) return key;
process.env.PORT || 4300    } catch {
process.env.PORT || 4300      // try the next candidate
process.env.PORT || 4300    }
process.env.PORT || 4300  }
process.env.PORT || 4300  return undefined;
process.env.PORT || 4300}
process.env.PORT || 4300
process.env.PORT || 4300const PROVIDER = assistantProvider();
process.env.PORT || 4300const MAIN_MODEL = PROVIDER === 'deepseek'
process.env.PORT || 4300  ? process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro'
process.env.PORT || 4300  : process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
process.env.PORT || 4300// Use the rolling alias (no dated snapshot suffix) so this keeps working once
process.env.PORT || 4300// Anthropic retires the specific snapshot it currently points at — pinning to
process.env.PORT || 4300// a dated snapshot (e.g. claude-haiku-4-5-20251001) causes title generation
process.env.PORT || 4300// (and any other caller of this constant) to break outright once that
process.env.PORT || 4300// snapshot reaches its deprecation/retirement date.
process.env.PORT || 4300const TITLE_MODEL = PROVIDER === 'deepseek'
process.env.PORT || 4300  ? process.env.DEEPSEEK_TITLE_MODEL || 'deepseek-v4-flash'
process.env.PORT || 4300  : process.env.ANTHROPIC_TITLE_MODEL || 'claude-haiku-4-5';
process.env.PORT || 4300
process.env.PORT || 4300const client = new Anthropic({
process.env.PORT || 4300  apiKey: resolveApiKey(PROVIDER),
process.env.PORT || 4300  baseURL: PROVIDER === 'deepseek' ? 'https://api.deepseek.com/anthropic' : 'https://api.anthropic.com',
process.env.PORT || 4300});
process.env.PORT || 4300
process.env.PORT || 4300const SYSTEM = `You are the Dockyard.ai assistant. You translate a user's natural-language request into tool calls that manage Lambda functions, Gateway routes, containers, Docker images, storage buckets, and saved MySQL/MongoDB connections.
process.env.PORT || 4300
process.env.PORT || 4300Rules:
process.env.PORT || 4300- Briefly describe what you're about to do before calling a tool, so the user can see what's happening. Never invent a resource id.
process.env.PORT || 4300- If the user names a resource by a friendly name/description rather than an id, and you don't already have that id from the user's message or an earlier tool result, first call the matching list_* tool to look it up (list_containers, list_functions, list_gateway_routes, list_buckets, list_images, list_host_build_presets, list_database_connections — these run automatically, no confirmation needed). If exactly one result matches, use its id. If there's no match or more than one plausible match, ask the user to clarify rather than guessing.
process.env.PORT || 4300- When the user refers to a resource vaguely ("the function", "it", "that one", "this bucket") without naming it, first check whether an earlier message or tool result in this same conversation already established which one. If exactly one resource was clearly the subject of the recent exchange, use its id directly without re-listing or re-asking. Only fall back to list_* or asking the user to clarify when no such resource is evident from the conversation so far.
process.env.PORT || 4300- When the user asks what a function does or wants to see its code, call read_function with its id — list_functions only returns id/name/runtime, not the source code. read_function runs automatically (no confirmation needed) and returns the full function details including code, runtime, packages, and entry point.
process.env.PORT || 4300- Before editing a file that might already exist in a bucket (e.g. "change the title", "add a button", "fix the CSS"), call list_bucket_objects and read_bucket_object first and base the edit on the real current content — never blindly regenerate a file from scratch when the request implies an existing one. write_bucket_object always replaces a file's entire content, so the new content you send must include everything you want kept, not just the changed part.
process.env.PORT || 4300- The "content"/"code" you send to write_bucket_object, write_bucket_objects, write_container_file, write_container_files, replace_in_bucket_object, replace_in_container_file, and create_lambda_function/update the function's code must be exactly the file's intended contents — nothing else. Never append a closing remark, joke, quip, watermark, or any other extra line/comment that wasn't asked for, especially not to the last line of a JSON, CSS, or other config/code file; a stray trailing phrase can break parsers.
process.env.PORT || 4300- For multi-step requests (e.g. "create a function and attach a gateway route to it"), call one tool at a time and wait for its real result before calling the next one — never invent an id.
process.env.PORT || 4300- Default runtime is "node" unless the user names another ("python" or "sh").
process.env.PORT || 4300- When writing a function's "code", write complete, runnable source for the chosen runtime. Functions invoked through a gateway route follow this contract: the incoming request arrives as JSON in the DOCKYARD_REQUEST environment variable, shaped like { httpMethod, path, headers, queryStringParameters, body, isBase64Encoded } (body may be null). The function must print exactly one JSON object to stdout shaped like { "statusCode": number, "headers"?: object, "body": string, "isBase64Encoded"?: boolean }. Do not print anything else to stdout.
process.env.PORT || 4300- When a gateway route targets a lambda function, targetType must be \"lambda\" and targetId must be the id returned by the create_lambda_function call. When it targets a bucket, targetType must be \"bucket\" and targetId is simply the bucket's name.\n    - All gateway routes are reachable at /gw/{name} — always tell the user the full URL when confirming a route was created. Critical: the backend receives the request with /gw/ stripped but the route name preserved — /gw/my-site/about → /my-site/about on the backend. When configuring a reverse proxy (nginx, etc.) or SPA, account for the /{name}/ path prefix (base href, asset paths, API endpoint prefixes all need it).
process.env.PORT || 4300- gateway route "pathPattern" is matched by EXACT string equality against the incoming request path (with the route's own name already stripped from the front) — there is no wildcard, glob, or prefix support. A trailing "/*" or "/:id" will never match anything real; do not use them. To match every path and method under a route (a whole static site, or a REST resource with multiple sub-paths like "/todos" and "/todos/{id}"), omit both "method" and "pathPattern" entirely rather than guessing a pattern.
process.env.PORT || 4300- A gateway route "name" is a group that can hold multiple method/pathPattern/target combinations — e.g. GET /todos going to one target and POST /todos/{id} going to another, all under the same name. create_gateway_route only accepts one method/pathPattern/targetId combination per call, so build up a multi-endpoint route by calling create_gateway_route once per combination, reusing the same "name" each time (this mirrors the "+ Add endpoint" button in the Gateway UI, which adds one endpoint to an existing named route). Never claim this isn't supported — it is; it just takes one tool call per endpoint, same as any other multi-step request.
process.env.PORT || 4300- To host a static website on a BUCKET (the default, simplest path): create the bucket first if it doesn't already exist (check with list_buckets), write the files with write_bucket_objects (accepts an array of { key, content } — prefer this bulk form for multi-file sites), then create_gateway_route with targetType "bucket" and targetId set to the bucket name, omitting method and pathPattern so every file in the site is reachable. Requests to "/" or a path with no file extension serve "index.html" (SPA-style fallback). For a quick single-file edit, use replace_in_bucket_object instead of reading and rewriting the whole file.
process.env.PORT || 4300- To host a site on an OS CONTAINER instead (when the user asks for a container/VM/server, needs a long-running process, dynamic requests, or explicitly wants it on a container rather than a bucket): call launch_container with a serving image — prefer "nginx:alpine" for static sites because its default command serves /usr/share/nginx/html on port 80 with no extra setup. Write the site files with write_container_files (accepts an array of { path, content } — prefer this bulk form), then create_gateway_route with targetType "container", targetId set to the container id returned by launch_container, targetPort 80, omitting method and pathPattern so every path reaches the container. For a quick single-file edit, use replace_in_container_file instead of rewriting the whole file. Use this path only when a container is genuinely wanted; otherwise default to the bucket path.
process.env.PORT || 4300- When launching a container for builds or development (not a serving container with a real server process), pass command: ["sleep", "infinity"] to launch_container to keep it alive — images like node:22-alpine exit immediately otherwise because their default CMD is just "node" with no script.
process.env.PORT || 4300- Containers launched through this assistant can run confirmed commands with execute_container_command. Pass command as an argument array, never as a shell string: for example, ["npm", "ci"] or ["npx", "ng", "build"]. Set workingDir when the project is not in the container's default working directory. To start a long-running server (e.g. a Node.js API), set background: true so the command runs detached and doesn't block — the tool returns immediately. IMPORTANT: background execs do NOT capture stdout/stderr; use get_container_logs for the container's primary process output, or run commands non-background to see their output inline. For one-shot commands whose output you need (builds, installs, file listings), always run them non-background. To update environment variables on a running container, use update_container_env — it stops, merges the new vars with existing ones, recreates the container, and starts it again. Pass persist: true to snapshot the writable layer before recreating so runtime files survive. The same tool also accepts a description parameter to add or update the iaas.description label on an already-running container (e.g. one launched before the description feature existed) — pass env, description, or both.
process.env.PORT || 4300- The host filesystem is available read-only within Dockyard's configured host-files mount. Use list_host_directory to inspect one directory at a time, then read_host_file to read an explicitly requested text file. Both require absolute host paths (for example, "/home/me/project"). Do not read files the user has not requested or that are likely to contain secrets (such as .env files, SSH keys, credential stores, or private keys). Host file reads are capped at 512 KiB and 50,000 characters; binary files cannot be read. To copy one host file to a bucket, use copy_host_file_to_bucket. To copy one host file to a container folder, use copy_host_file_to_container. Both require confirmation and accept the source as its absolute HOST path. Host file transfers support regular files up to 200 MiB.
process.env.PORT || 4300- To build a configured host project and deploy its artifacts to a container, first call list_host_build_presets to find the exact preset, then call run_host_build_preset with its name, target container id, and destination directory. Presets contain fixed host-side commands and artifact directories; never invent a command, command arguments, working directory, or artifact path.
process.env.PORT || 4300- For database work, always resolve the saved connection id first (list_database_connections unless it is already known). Use inspect_database_schema to explore structure, run_database_read_query for bounded read-only access, execute_database_mutation for one confirmed write, execute_database_migration for confirmed schema/multi-step changes, execute_database_access_grant for structured MySQL GRANT or MongoDB grantRolesToUser requests, create_database_backup to generate a backup job, restore_database_backup to restore from a prior backup job id, and list_database_jobs / get_database_job to inspect backup or restore history.
process.env.PORT || 4300- For MySQL reads, run_database_read_query must receive one read-only SQL statement in the sql field. For MongoDB reads, use run_database_read_query with collection plus mode/find/aggregate/count and JSON filter/projection/sort/pipeline fields as needed. Never use execute_database_mutation or execute_database_migration for a read-only request.
process.env.PORT || 4300- Destructive or disruptive actions (delete_*, prune_*, container_action) still go through the normal tool-call flow — the user reviews and confirms every tool call before it executes, so call the tool directly rather than asking "are you sure?" in text first. write_container_file, write_container_files, write_bucket_objects, replace_in_container_file, replace_in_bucket_object, update_container_env, host-file copies, and launch_container are no exception: call them directly; the user confirms before they run.
process.env.PORT || 4300- Database writes, migrations, grants, backups, restores, and saved-connection create/update/delete/test actions are also confirmed by the user before client execution, so call the appropriate tool directly instead of asking for a second textual confirmation.
process.env.PORT || 4300- For GitHub: use list_github_repo_files and read_github_file to browse or read one repo's content (public repos need no token; private repos need a configured GitHub token and fail with a clear error otherwise). When the user wants to pull an ENTIRE repo (not just one file) onto Dockyard, use pull_github_repo_to_bucket (bucket must already exist) or pull_github_repo_to_container (container must be running) — these download the whole repo tree and write every file, preserving folder structure; do not try to read and re-write each file individually for a whole-repo pull. Pass clean: true to delete the destination first, ensuring stale files from a previous pull don't linger. To commit and push changes back to GitHub, use commit_and_push_github_files with the complete new content of every changed file — it clones (or refreshes an existing local clone), commits, and pushes to the given branch (or the repo's default branch); this always requires a configured GitHub token. All four mutating GitHub tools (the two pull tools and commit_and_push_github_files) require user confirmation — call them directly rather than asking a second time in text.
process.env.PORT || 4300- When you need to pause between polling operations (e.g. waiting for a container to start, a build to finish, a database backup to complete, or a resource to become available), call wait with the number of seconds to pause (1-60) and an optional short reason describing what you're waiting for. The server will sleep for that duration and show a countdown progress bar to the user. This runs automatically with no confirmation needed. When polling the same resource repeatedly, you MUST call wait between every check. Calling the same read-only tool twice within 10 seconds without an intervening wait is forbidden — never fire rapid back-to-back polls of the same tool.
process.env.PORT || 4300	- Dockyard runs an issue consumer: an auto-fix bot that continuously polls the issue store for open issues, applies Claude Code to diagnose and fix them against this codebase, and pushes the resulting commits to GitHub. When you log an issue via report_issue, the consumer picks it up automatically (usually within seconds). After reporting an issue, proactively mention the consumer and offer to check its progress: call get_consumer_status to see whether the consumer is currently idle or actively working on a specific issue, and get_consumer_activity to review recent fix attempts and their outcomes (including GitHub commit links for successful fixes). If the consumer failed to process an issue (e.g. a timeout or an API error), use retry_issue to re-open it so the consumer picks it up on the next poll cycle. The feedback loop closes when an issue transitions to "resolved" with a linked commit. The user may not realize this happened unless you surface it.
process.env.PORT || 4300	- When done, give a short (1-2 sentence) confirmation of what was done — no more.`;
process.env.PORT || 4300
process.env.PORT || 4300const tools: Anthropic.Tool[] = [
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "create_lambda_function",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Create a new Lambda-style function in Dockyard.ai. Call this when the user wants to create/define a function.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        name: { type: "string", description: "Function name" },
process.env.PORT || 4300        runtime: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          enum: ["node", "python", "sh"],
process.env.PORT || 4300          description: "Defaults to node",
process.env.PORT || 4300        },
process.env.PORT || 4300        code: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: "Complete source code for the function's entry file",
process.env.PORT || 4300        },
process.env.PORT || 4300        packages: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: "Space-separated packages to install, if any",
process.env.PORT || 4300        },
process.env.PORT || 4300        entryPoint: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: "Entry filename, e.g. index.js",
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["name", "code"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "create_gateway_route",
process.env.PORT || 4300    description:
process.env.PORT || 4300      'Create an API Gateway route pointing at a target resource. The route will be reachable at /gw/{name}. Important: the backend receives the request with the /gw/ prefix stripped but the route name preserved — e.g. /gw/my-site/about becomes /my-site/about on the backend. Tell the user this so they configure their server/app correctly (e.g. nginx needs to serve from /{name}/..., and SPA base href or asset paths must account for the route name prefix). Call this when the user wants to expose or attach an endpoint. For targetType "lambda", targetId is the id returned by create_lambda_function. For targetType "bucket", targetId is just the bucket name (no lookup needed) — use this to serve a static site written with write_bucket_object. For targetType "container", targetId is the container id returned by launch_container and targetPort is the port the server listens on inside that container (e.g. 80 for nginx) — use this to serve a site hosted on an OS container written with write_container_file.',
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        name: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description:
process.env.PORT || 4300            "Route name: lowercase letters/digits/hyphens, starting with a letter or digit. This is the URL segment: /gw/{name}.",
process.env.PORT || 4300        },
process.env.PORT || 4300        displayName: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: "Optional human-readable display name shown in the UI instead of the URL slug.",
process.env.PORT || 4300        },
process.env.PORT || 4300        targetType: { type: "string", enum: ["lambda", "container", "bucket"] },
process.env.PORT || 4300        targetId: { type: "string" },
process.env.PORT || 4300        targetPort: {
process.env.PORT || 4300          type: "number",
process.env.PORT || 4300          description:
process.env.PORT || 4300            'For targetType "container" only: the port the server listens on inside the target container (e.g. 80 for nginx). Omit for lambda/bucket targets.',
process.env.PORT || 4300        },
process.env.PORT || 4300        method: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
process.env.PORT || 4300        },
process.env.PORT || 4300        pathPattern: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description:
process.env.PORT || 4300            'Must start with "/". Matched by EXACT string equality against the request path — no wildcards or path params (a trailing "/*" or "/:id" never matches). Omit this (and method) entirely for a catch-all route matching every path/method, which is usually what you want for a bucket-hosted site, a container-hosted site, or a multi-path REST resource.',
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["name", "targetType", "targetId"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "update_lambda_function",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Update an existing Lambda function's name, runtime, code, packages, entry point, or additional files.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        id: { type: "string", description: "Function id, e.g. fn-abc123" },
process.env.PORT || 4300        name: { type: "string" },
process.env.PORT || 4300        runtime: { type: "string", enum: ["node", "python", "sh"] },
process.env.PORT || 4300        code: { type: "string" },
process.env.PORT || 4300        packages: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: "Space-separated packages to install",
process.env.PORT || 4300        },
process.env.PORT || 4300        entryPoint: { type: "string" },
process.env.PORT || 4300        files: {
process.env.PORT || 4300          type: "array",
process.env.PORT || 4300          description:
process.env.PORT || 4300            "Additional function files, excluding the entry point. Replaces the complete additional-file list when provided.",
process.env.PORT || 4300          items: {
process.env.PORT || 4300            type: "object",
process.env.PORT || 4300            properties: {
process.env.PORT || 4300              path: { type: "string", description: "Relative file path" },
process.env.PORT || 4300              content: { type: "string", description: "Complete file content" },
process.env.PORT || 4300            },
process.env.PORT || 4300            required: ["path", "content"],
process.env.PORT || 4300          },
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["id"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "replace_lambda_function_files",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Replace the complete source file set of an existing Lambda function. Use this for any code edit that adds, removes, or changes files. The files array must contain the entry point and every additional file that should remain.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        id: { type: "string", description: "Function id, e.g. fn-abc123" },
process.env.PORT || 4300        entryPoint: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: "Path of the file to execute",
process.env.PORT || 4300        },
process.env.PORT || 4300        files: {
process.env.PORT || 4300          type: "array",
process.env.PORT || 4300          description:
process.env.PORT || 4300            "Complete function file set, including the entry point and every retained additional file.",
process.env.PORT || 4300          items: {
process.env.PORT || 4300            type: "object",
process.env.PORT || 4300            properties: {
process.env.PORT || 4300              path: { type: "string", description: "Relative file path" },
process.env.PORT || 4300              content: { type: "string", description: "Complete file content" },
process.env.PORT || 4300            },
process.env.PORT || 4300            required: ["path", "content"],
process.env.PORT || 4300          },
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["id", "entryPoint", "files"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "delete_lambda_function",
process.env.PORT || 4300    description: "Delete a saved Lambda function by id.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: { id: { type: "string" } },
process.env.PORT || 4300      required: ["id"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "delete_gateway_route",
process.env.PORT || 4300    description: "Delete a gateway route by id.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: { id: { type: "string" } },
process.env.PORT || 4300      required: ["id"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "launch_container",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Launch a new Docker container, either from a named preset or a raw image. Pass command to override the image's default CMD — useful for keeping build images alive with [\"sleep\",\"infinity\"] when they'd otherwise exit immediately.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        presetId: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: "A known preset id, if the user named one",
process.env.PORT || 4300        },
process.env.PORT || 4300        image: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description:
process.env.PORT || 4300            'Docker image (e.g. "redis:7-alpine"), if not using a preset',
process.env.PORT || 4300        },
process.env.PORT || 4300        name: { type: "string", description: "Container name" },
process.env.PORT || 4300        description: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: "Optional free-text note describing the container's purpose, shown in list_containers and inspect_container output.",
process.env.PORT || 4300        },
process.env.PORT || 4300        protected: {
process.env.PORT || 4300          type: "boolean",
process.env.PORT || 4300          description: "If true, guard this container against accidental start/stop/restart/removal from the UI and assistant (e.g. important long-lived infrastructure like a queue or database). Can be changed later with update_container_env.",
process.env.PORT || 4300        },
process.env.PORT || 4300        command: {
process.env.PORT || 4300          type: "array",
process.env.PORT || 4300          description: 'Override the default CMD, e.g. ["sleep","infinity"] or ["tail","-f","/dev/null"]. Pass as separate string arguments, not a shell string.',
process.env.PORT || 4300          items: { type: "string" },
process.env.PORT || 4300        },
process.env.PORT || 4300        ports: {
process.env.PORT || 4300          type: "array",
process.env.PORT || 4300          description: "Port mappings",
process.env.PORT || 4300          items: {
process.env.PORT || 4300            type: "object",
process.env.PORT || 4300            properties: {
process.env.PORT || 4300              container: {
process.env.PORT || 4300                type: "string",
process.env.PORT || 4300                description: 'Container-side port, e.g. "6379" or "6379/tcp"',
process.env.PORT || 4300              },
process.env.PORT || 4300              host: { type: "number", description: "Host-side port" },
process.env.PORT || 4300            },
process.env.PORT || 4300            required: ["container", "host"],
process.env.PORT || 4300          },
process.env.PORT || 4300        },
process.env.PORT || 4300        env: {
process.env.PORT || 4300          type: "array",
process.env.PORT || 4300          description: "Environment variables",
process.env.PORT || 4300          items: {
process.env.PORT || 4300            type: "object",
process.env.PORT || 4300            properties: { key: { type: "string" }, value: { type: "string" } },
process.env.PORT || 4300            required: ["key", "value"],
process.env.PORT || 4300          },
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: [],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "container_action",
process.env.PORT || 4300    description: "Start, stop, or restart an existing container.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        id: { type: "string", description: "Container id" },
process.env.PORT || 4300        action: { type: "string", enum: ["start", "stop", "restart"] },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["id", "action"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "write_container_file",
process.env.PORT || 4300    description:
process.env.PORT || 4300      'Write (create or overwrite) a text file inside a running container at an absolute path. Use this to host a static site on an OS container: launch a serving image such as nginx:alpine (which serves /usr/share/nginx/html on port 80 by default), write each site file there (e.g. /usr/share/nginx/html/index.html, /usr/share/nginx/html/style.css), then create_gateway_route with targetType "container", targetId set to that container id, and targetPort 80.',
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        id: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description:
process.env.PORT || 4300            "Container id (from launch_container or list_containers)",
process.env.PORT || 4300        },
process.env.PORT || 4300        path: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description:
process.env.PORT || 4300            'Absolute path inside the container, e.g. "/usr/share/nginx/html/index.html"',
process.env.PORT || 4300        },
process.env.PORT || 4300        content: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: "The file's full text content",
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["id", "path", "content"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "execute_container_command",
process.env.PORT || 4300    description:
process.env.PORT || 4300      'Run a command in a running container that this assistant launched. Requires user confirmation. Pass command as separate arguments, e.g. ["npm", "ci"] or ["npx", "ng", "build"], not a shell command string. Returns combined stdout/stderr and exit code. Use workingDir for the project directory.',
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        id: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: "Container id returned by launch_container",
process.env.PORT || 4300        },
process.env.PORT || 4300        command: {
process.env.PORT || 4300          type: "array",
process.env.PORT || 4300          description: 'Executable and arguments, e.g. ["npm", "ci"]',
process.env.PORT || 4300          items: { type: "string" },
process.env.PORT || 4300        },
process.env.PORT || 4300        workingDir: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: 'Optional absolute project directory inside the container, e.g. "/workspace"',
process.env.PORT || 4300        },
process.env.PORT || 4300        background: {
process.env.PORT || 4300          type: "boolean",
process.env.PORT || 4300          description: 'If true, start the command detached and return immediately. The output is captured in the background and can be retrieved later with get_container_exec_output using the returned execId.',
process.env.PORT || 4300        },
process.env.PORT || 4300        timeoutSeconds: {
process.env.PORT || 4300          type: "number",
process.env.PORT || 4300          description: 'Optional timeout in seconds (1-600, max 10 min). Command is terminated after this window; partial output is returned.',
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["id", "command"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "get_container_exec_output",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Retrieve the captured stdout/stderr and exit code from a background exec. Pass the execId returned by a prior execute_container_command call with background:true. Output is buffered and available for 5 minutes after the command finishes.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: { execId: { type: "string", description: "Exec id from the background execute_container_command result" } },
process.env.PORT || 4300      required: ["execId"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "copy_host_file_to_container",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Copy one existing regular file from the host filesystem into a running, non-system container. This copies binary data without reading its contents into the conversation. The user must explicitly name the absolute host source path and the absolute destination path inside the container. Requires user confirmation.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        sourcePath: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description:
process.env.PORT || 4300            'Absolute path on the Docker host, e.g. "/home/me/report.pdf"',
process.env.PORT || 4300        },
process.env.PORT || 4300        id: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description:
process.env.PORT || 4300            "Container id (from launch_container or list_containers)",
process.env.PORT || 4300        },
process.env.PORT || 4300        path: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: "Absolute destination file path inside the container",
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["sourcePath", "id", "path"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "delete_container",
process.env.PORT || 4300    description: "Remove a container by id.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        id: { type: "string" },
process.env.PORT || 4300        force: { type: "boolean", description: "Force-remove even if running" },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["id"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "delete_image",
process.env.PORT || 4300    description: "Remove a Docker image by id.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        id: { type: "string" },
process.env.PORT || 4300        force: { type: "boolean" },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["id"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "prune_images",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Prune unused/dangling Docker images and stopped containers to reclaim disk space. Takes no arguments.",
process.env.PORT || 4300    input_schema: { type: "object", properties: {}, required: [] },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "create_bucket",
process.env.PORT || 4300    description: "Create a new storage bucket.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: { name: { type: "string" } },
process.env.PORT || 4300      required: ["name"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "delete_bucket",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Delete a storage bucket by name. Fails if the bucket is not empty.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: { name: { type: "string" } },
process.env.PORT || 4300      required: ["name"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "delete_bucket_object",
process.env.PORT || 4300    description: "Delete a single object (file) from a storage bucket.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        name: { type: "string", description: "Bucket name" },
process.env.PORT || 4300        key: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: "Object key/path within the bucket",
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["name", "key"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "write_bucket_object",
process.env.PORT || 4300    description:
process.env.PORT || 4300      'Write (create or overwrite) a text file in a storage bucket — the bucket must already exist. Use this to build a static website: write "index.html", "style.css", "script.js", etc., one file per call, then create_gateway_route with targetType "bucket" to serve them.',
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        name: { type: "string", description: "Bucket name" },
process.env.PORT || 4300        key: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description:
process.env.PORT || 4300            'Object key/path within the bucket, e.g. "index.html" or "assets/style.css"',
process.env.PORT || 4300        },
process.env.PORT || 4300        content: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: "The file's full text content",
process.env.PORT || 4300        },
process.env.PORT || 4300        contentType: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description:
process.env.PORT || 4300            "MIME type, e.g. text/html, text/css, application/javascript, application/json. Defaults to text/plain.",
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["name", "key", "content"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "copy_host_file_to_bucket",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Copy one existing regular file from the host filesystem into an existing storage bucket. This copies binary data without reading its contents into the conversation. The user must explicitly name the absolute host source path, destination bucket, and destination object key. Requires user confirmation.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        sourcePath: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description:
process.env.PORT || 4300            'Absolute path on the Docker host, e.g. "/home/me/report.pdf"',
process.env.PORT || 4300        },
process.env.PORT || 4300        bucket: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: "Existing destination bucket name",
process.env.PORT || 4300        },
process.env.PORT || 4300        key: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: "Destination object key/path in the bucket",
process.env.PORT || 4300        },
process.env.PORT || 4300        contentType: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: "Optional MIME type, e.g. application/pdf",
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["sourcePath", "bucket", "key"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "list_host_directory",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "List the immediate entries in an absolute directory on the read-only host-files mount. Returns up to 500 entries with names, types, sizes for files, and modification times. Use this before reading a host file when the user asks to inspect a directory.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        sourcePath: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: 'Absolute host directory path, e.g. "/home/me/project"',
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["sourcePath"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "read_host_file",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Read the UTF-8 text content of one explicitly requested regular file on the read-only host-files mount. File contents are returned to the conversation. Do not use for binary files or likely secret files. Limited to 512 KiB and 50,000 characters.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        sourcePath: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: 'Absolute host file path, e.g. "/home/me/project/package.json"',
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["sourcePath"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "run_host_build_preset",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Run a named, administrator-configured host build preset and copy its configured artifact directory into a running non-system container. The preset fixes the host command, arguments, working directory, and artifact path; this tool accepts only the preset name, target container id, and destination directory. Requires user confirmation.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        preset: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description:
process.env.PORT || 4300            "Configured host build preset name (from list_host_build_presets)",
process.env.PORT || 4300        },
process.env.PORT || 4300        id: { type: "string", description: "Target container id" },
process.env.PORT || 4300        path: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description:
process.env.PORT || 4300            "Absolute destination directory inside the target container",
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["preset", "id", "path"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "prune_build_cache",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Prune the Docker build cache to reclaim disk space. Takes no arguments.",
process.env.PORT || 4300    input_schema: { type: "object", properties: {}, required: [] },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "list_containers",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "List all containers (id, name, image, state) — use this to resolve a container the user referred to by name to its id.",
process.env.PORT || 4300    input_schema: { type: "object", properties: {}, required: [] },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "list_functions",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "List all saved Lambda functions (id, name, runtime) — use this to resolve a function's name to its id.",
process.env.PORT || 4300    input_schema: { type: "object", properties: {}, required: [] },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "list_gateway_routes",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "List all gateway routes (id, name, targetType, targetId, method, pathPattern) — use this to resolve a route's name to its id.",
process.env.PORT || 4300    input_schema: { type: "object", properties: {}, required: [] },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "list_buckets",
process.env.PORT || 4300    description: "List all storage buckets (name).",
process.env.PORT || 4300    input_schema: { type: "object", properties: {}, required: [] },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "list_images",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "List all Docker images (id, tags) — use this to resolve an image's tag to its id.",
process.env.PORT || 4300    input_schema: { type: "object", properties: {}, required: [] },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "list_bucket_objects",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "List the files (and folder-like prefixes) inside a bucket, optionally under a prefix. Use this before modifying an existing bucket-hosted site to see what files already exist.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        name: { type: "string", description: "Bucket name" },
process.env.PORT || 4300        prefix: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: 'Only list keys under this prefix, e.g. "assets/"',
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["name"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "read_bucket_object",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Read a text file's content from a bucket. Use this before editing an existing file with write_bucket_object, so the edit is based on the real current content rather than a guess.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        name: { type: "string", description: "Bucket name" },
process.env.PORT || 4300        key: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: 'Object key/path within the bucket, e.g. "index.html"',
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["name", "key"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "read_function",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Read a Lambda function's full details including its source code, runtime, packages, and entry point. Use this when the user asks what a function does or wants to see its code — list_functions only returns id/name/runtime, not the code itself.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        id: { type: "string", description: "Function id, e.g. fn-abc123" },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["id"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "get_container_logs",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Fetch a container's recent stdout/stderr log output (read-only, runs automatically with no confirmation). Use this when the user asks what a container is doing, why it isn't working, or wants to see its logs. Returns up to `tail` lines (default 200).",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        id: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description:
process.env.PORT || 4300            "Container id (from list_containers or launch_container)",
process.env.PORT || 4300        },
process.env.PORT || 4300        tail: {
process.env.PORT || 4300          type: "number",
process.env.PORT || 4300          description: "Number of recent lines to fetch (default 200, max 500)",
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["id"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "inspect_container",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Inspect a container's configuration (read-only, runs automatically with no confirmation): image, state, published ports, volumes, restart policy, and labels. Environment variable VALUES are redacted for safety — only the env var NAMES are returned. Use this when the user asks how a container is configured or what it's running.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        id: { type: "string", description: "Container id" },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["id"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "list_presets",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "List the launchable image presets (the gallery of quick-start images — analogous to AMIs): each preset has an id, name, category, image, description, suggested ports and env defaults. Use this when the user asks what they can launch or wants to pick a preset to run. Read-only, runs automatically with no confirmation.",
process.env.PORT || 4300    input_schema: { type: "object", properties: {}, required: [] },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "list_used_ports",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "List the host ports currently published by running containers (read-only, runs automatically with no confirmation). Use this before launching a container with a specific host port to avoid a conflict, or when the user asks what ports are in use.",
process.env.PORT || 4300    input_schema: { type: "object", properties: {}, required: [] },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "list_host_build_presets",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "List administrator-configured host build presets. Each preset has a name, fixed command/arguments, host working directory, and artifact directory. Read-only, runs automatically with no confirmation.",
process.env.PORT || 4300    input_schema: { type: "object", properties: {}, required: [] },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "run_function",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Run a saved Lambda function by id and return its stdout, status code, and duration. Use this when the user asks to test or run a function. An optional JSON `payload` is provided to the function as the DOCKYARD_REQUEST environment variable (the gateway contract); omit it for functions that take no request. The function runs with its saved environment variables, the same as the editor Run button and gateway invocations. The user confirms before it runs.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        id: { type: "string", description: "Function id, e.g. fn-abc123" },
process.env.PORT || 4300        payload: {
process.env.PORT || 4300          type: "object",
process.env.PORT || 4300          description:
process.env.PORT || 4300            "Optional request payload passed to the function as DOCKYARD_REQUEST (JSON)",
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["id"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "update_container_env",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Update (add, change, or merge) environment variables, the description, and/or the protected flag on a container. Stops the container, merges the new env vars with existing ones, recreates the container with the same image/config, and starts it again if it was running. By default, recreating from the image wipes the container's writable filesystem layer. Pass persist: true to snapshot the writable layer first via docker commit — this preserves all runtime files (deployed sites, installed packages, config edits) across the update. Pass description to add or update the iaas.description label on an existing container (pass an empty string to clear it) — use this to retroactively add a description to a container that was launched before one was set. Pass protected: true to guard a container against accidental start/stop/restart/removal from the UI and assistant (pass protected: false to unprotect it again). Provide any combination of env, description, and protected. Requires user confirmation.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        id: { type: "string", description: "Container id" },
process.env.PORT || 4300        env: {
process.env.PORT || 4300          type: "array",
process.env.PORT || 4300          description: "Environment variables to set/update. Optional if only updating description/protected.",
process.env.PORT || 4300          items: {
process.env.PORT || 4300            type: "object",
process.env.PORT || 4300            properties: { key: { type: "string" }, value: { type: "string" } },
process.env.PORT || 4300            required: ["key", "value"],
process.env.PORT || 4300          },
process.env.PORT || 4300        },
process.env.PORT || 4300        description: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: "New free-text description to set as the container's iaas.description label. Pass an empty string to clear an existing description.",
process.env.PORT || 4300        },
process.env.PORT || 4300        protected: {
process.env.PORT || 4300          type: "boolean",
process.env.PORT || 4300          description: "Set to true to protect the container from start/stop/restart/removal (in the UI and via container_action/delete_container); set to false to remove that protection.",
process.env.PORT || 4300        },
process.env.PORT || 4300        persist: {
process.env.PORT || 4300          type: "boolean",
process.env.PORT || 4300          description: "If true, snapshot the writable filesystem layer before recreating so runtime files survive the update.",
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["id"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "replace_in_container_file",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Search-and-replace literal text in one file inside a running container. Reads the file, replaces all occurrences of the search string with the replacement, and writes it back. Use this instead of raw sed for safer, more discoverable edits. Requires user confirmation.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        id: { type: "string", description: "Container id" },
process.env.PORT || 4300        path: { type: "string", description: "Absolute file path inside the container" },
process.env.PORT || 4300        search: { type: "string", description: "Literal string to find (not a regex)" },
process.env.PORT || 4300        replace: { type: "string", description: "Replacement string" },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["id", "path", "search", "replace"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "replace_in_bucket_object",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Search-and-replace literal text in one object (file) inside a storage bucket. Reads the object, replaces all occurrences of the search string with the replacement, and writes it back. Use this instead of reading the whole file and rewriting it. Requires user confirmation.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        name: { type: "string", description: "Bucket name" },
process.env.PORT || 4300        key: { type: "string", description: "Object key within the bucket" },
process.env.PORT || 4300        search: { type: "string", description: "Literal string to find (not a regex)" },
process.env.PORT || 4300        replace: { type: "string", description: "Replacement string" },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["name", "key", "search", "replace"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "list_container_files",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Recursively list files in a container directory (read-only, auto-resolved). Uses `find` with a configurable max depth (default 4, max 8). Returns file/directory entries with names, sizes, and modification times. Use this instead of ad-hoc `execute_container_command` with `find` or `ls -R`.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        id: { type: "string", description: "Container id" },
process.env.PORT || 4300        path: { type: "string", description: "Absolute container path, defaults to /" },
process.env.PORT || 4300        maxDepth: { type: "number", description: "Max recursion depth (1-8, default 4)" },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["id"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "probe_container_endpoint",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Probe an HTTP endpoint inside a running container from Dockyard's own process (same Docker network). Returns the HTTP status code, response headers, and up to 4 KiB of the response body. Use this to check whether a service is up, verify its response, or troubleshoot connectivity — especially when the container lacks curl/wget.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        id: { type: "string", description: "Container id" },
process.env.PORT || 4300        port: { type: "number", description: "Port inside the container, e.g. 6006" },
process.env.PORT || 4300        path: { type: "string", description: "Request path, defaults to /" },
process.env.PORT || 4300        method: { type: "string", enum: ["GET", "HEAD"], description: "HTTP method, defaults to GET" },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["id", "port"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "write_container_files",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Write (create or overwrite) multiple text files inside a running container in a single call. Takes an array of { path, content } — each path is an absolute container path. Use this for multi-file site deploys to avoid one round trip per file. Requires user confirmation.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        id: { type: "string", description: "Container id" },
process.env.PORT || 4300        files: {
process.env.PORT || 4300          type: "array",
process.env.PORT || 4300          description: "Files to write",
process.env.PORT || 4300          items: {
process.env.PORT || 4300            type: "object",
process.env.PORT || 4300            properties: {
process.env.PORT || 4300              path: { type: "string", description: "Absolute container path, e.g. \"/usr/share/nginx/html/index.html\"" },
process.env.PORT || 4300              content: { type: "string", description: "Complete file content" },
process.env.PORT || 4300            },
process.env.PORT || 4300            required: ["path", "content"],
process.env.PORT || 4300          },
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["id", "files"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "write_bucket_objects",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Write (create or overwrite) multiple objects in a storage bucket in a single call. Takes an array of { key, content, contentType? }. Use this for multi-file static site deploys to avoid one round trip per file. Requires user confirmation.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        name: { type: "string", description: "Bucket name" },
process.env.PORT || 4300        objects: {
process.env.PORT || 4300          type: "array",
process.env.PORT || 4300          description: "Objects to write",
process.env.PORT || 4300          items: {
process.env.PORT || 4300            type: "object",
process.env.PORT || 4300            properties: {
process.env.PORT || 4300              key: { type: "string", description: "Object key/path within the bucket" },
process.env.PORT || 4300              content: { type: "string", description: "Complete file text content" },
process.env.PORT || 4300              contentType: { type: "string", description: "Optional MIME type, defaults to text/plain" },
process.env.PORT || 4300            },
process.env.PORT || 4300            required: ["key", "content"],
process.env.PORT || 4300          },
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["name", "objects"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "report_issue",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Report a bug, error, missing feature, or operational issue. Persists a structured report to the Dockyard issue store so it can be reviewed later. Use this when you encounter an error that prevented you from completing a user request, or when a user explicitly asks you to log an issue. Include a clear summary, a category (bug, error, missing_feature, performance, security, or general), and any relevant contextual details such as the resource ids, tool names, error messages, and reproduction steps.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        summary: { type: "string", description: "Short one-line description of the issue" },
process.env.PORT || 4300        category: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          enum: ["bug", "error", "missing_feature", "performance", "security", "general"],
process.env.PORT || 4300          description: "Issue category",
process.env.PORT || 4300        },
process.env.PORT || 4300        details: {
process.env.PORT || 4300          type: "object",
process.env.PORT || 4300          description: "Structured details: what happened, expected outcome, relevant resource ids, tool names, error messages, reproduction steps, and any context that helps diagnose the issue.",
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["summary"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "list_issues",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "List recently reported issues from the issue store, newest first. Use this to check whether a problem has already been reported before filing a duplicate.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        limit: { type: "number", description: "Maximum results (default 20, max 50)" },
process.env.PORT || 4300        status: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          enum: ["open", "in_progress", "resolved", "closed", "wont_fix"],
process.env.PORT || 4300          description: "If set, only issues with this status are returned. Omit to include all statuses (including resolved/closed).",
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: [],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "get_issue",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Read one reported issue by id, including its full details.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: { issueId: { type: "string", description: "Issue id, e.g. iss-abc123" } },
process.env.PORT || 4300      required: ["issueId"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "update_issue",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Update a reported issue's status and/or record its resolution. Use this to mark an issue as in progress, resolved, closed, or won't-fix, and to leave an audit trail describing what was done and by whom.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        issueId: { type: "string", description: "Issue id, e.g. iss-abc123" },
process.env.PORT || 4300        status: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          enum: ["open", "in_progress", "resolved", "closed", "wont_fix"],
process.env.PORT || 4300          description: "New status for the issue.",
process.env.PORT || 4300        },
process.env.PORT || 4300        resolution: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: "Free-text description of what was done to address the issue. Meaningful for resolved/closed issues.",
process.env.PORT || 4300        },
process.env.PORT || 4300        resolvedBy: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description: "Optional — who or what resolved the issue (e.g. a user name, or 'assistant').",
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["issueId"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "delete_issue",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Permanently delete one reported issue by id. Use this to clear a single issue once it has been resolved or is no longer relevant.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: { issueId: { type: "string", description: "Issue id, e.g. iss-abc123" } },
process.env.PORT || 4300      required: ["issueId"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "clear_issues",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Bulk-delete reported issues from the issue store, e.g. to clear out everything once it has been triaged/resolved. Optionally restrict to a single category; omit to clear all issues visible to the current user.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        category: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          enum: ["bug", "error", "missing_feature", "performance", "security", "general"],
process.env.PORT || 4300          description: "If set, only issues in this category are deleted. Omit to clear all issues.",
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: [],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "wait",
process.env.PORT || 4300    description:
process.env.PORT || 4300      "Pause between polling operations to avoid hammering the API. Call this when you need to wait before checking again — for example, waiting for a container to start, a build to finish, a database backup to complete, or any resource to become available. The server will sleep for the requested number of seconds and show a countdown progress bar to the user. Runs automatically with no confirmation needed.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        seconds: {
process.env.PORT || 4300          type: "number",
process.env.PORT || 4300          description:
process.env.PORT || 4300            "Number of seconds to wait (1-60). The server clamps values outside this range.",
process.env.PORT || 4300        },
process.env.PORT || 4300        reason: {
process.env.PORT || 4300          type: "string",
process.env.PORT || 4300          description:
process.env.PORT || 4300            "Optional short reason shown to the user during the countdown, e.g. 'container starting' or 'build in progress'.",
process.env.PORT || 4300        },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["seconds"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "get_consumer_status",
process.env.PORT || 4300    description: "Check the current status of the Dockyard issue consumer. Returns idle, processing (with issue details), errored, or no-auth. Use this to see what the consumer is doing right now.",
process.env.PORT || 4300    input_schema: { type: "object", properties: {}, required: [] },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "get_consumer_activity",
process.env.PORT || 4300    description: "List recent consumer activity — which issues were processed, the outcome (fixed/failed), and links to GitHub commits. Returns up to 10 recent entries.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        limit: { type: "number", description: "Max entries to return (1-20, default 10)" },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: [],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  {
process.env.PORT || 4300    name: "retry_issue",
process.env.PORT || 4300    description: "Re-open an issue so the consumer picks it up again. Use when the consumer failed to process an issue and you want to retry.",
process.env.PORT || 4300    input_schema: {
process.env.PORT || 4300      type: "object",
process.env.PORT || 4300      properties: {
process.env.PORT || 4300        issueId: { type: "string", description: "The issue ID to retry" },
process.env.PORT || 4300      },
process.env.PORT || 4300      required: ["issueId"],
process.env.PORT || 4300    },
process.env.PORT || 4300  },
process.env.PORT || 4300  ...DATABASE_ASSISTANT_TOOLS,
process.env.PORT || 4300  ...GITHUB_ASSISTANT_TOOLS,
process.env.PORT || 4300];
process.env.PORT || 4300
process.env.PORT || 4300/** These tools have no side effects, so the server executes them itself and
process.env.PORT || 4300 *  loops back to Claude immediately — the client never sees them and never
process.env.PORT || 4300 *  has to confirm a plain lookup. */
process.env.PORT || 4300const READ_ONLY_TOOLS = new Set([
process.env.PORT || 4300  "list_containers",
process.env.PORT || 4300  "list_functions",
process.env.PORT || 4300  "list_gateway_routes",
process.env.PORT || 4300  "list_buckets",
process.env.PORT || 4300  "list_images",
process.env.PORT || 4300  "list_bucket_objects",
process.env.PORT || 4300  "read_bucket_object",
process.env.PORT || 4300  "read_function",
process.env.PORT || 4300  "get_container_logs",
process.env.PORT || 4300  "inspect_container",
process.env.PORT || 4300  "list_presets",
process.env.PORT || 4300  "list_used_ports",
process.env.PORT || 4300  "list_host_build_presets",
process.env.PORT || 4300  "list_host_directory",
process.env.PORT || 4300  "read_host_file",
process.env.PORT || 4300  "list_container_files",
process.env.PORT || 4300  "probe_container_endpoint",
process.env.PORT || 4300  "get_container_exec_output",
process.env.PORT || 4300  "list_issues",
process.env.PORT || 4300  "get_issue",
process.env.PORT || 4300  "get_consumer_status",
process.env.PORT || 4300  "get_consumer_activity",
process.env.PORT || 4300  ...DATABASE_ASSISTANT_READ_ONLY_TOOLS,
process.env.PORT || 4300  ...GITHUB_ASSISTANT_READ_ONLY_TOOLS,
process.env.PORT || 4300]);
process.env.PORT || 4300
process.env.PORT || 4300/** Caps how much of a bucket object's content gets fed back to Claude — a
process.env.PORT || 4300 *  multi-MB asset would otherwise blow up the conversation's token count. */
process.env.PORT || 4300const MAX_OBJECT_READ_CHARS = 50_000;
process.env.PORT || 4300
process.env.PORT || 4300async function streamToString(body: unknown): Promise<string> {
process.env.PORT || 4300  const chunks: Buffer[] = [];
process.env.PORT || 4300  for await (const chunk of body as AsyncIterable<Buffer | string>) {
process.env.PORT || 4300    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
process.env.PORT || 4300  }
process.env.PORT || 4300  return Buffer.concat(chunks).toString("utf8");
process.env.PORT || 4300}
process.env.PORT || 4300
process.env.PORT || 4300async function executeReadOnlyTool(
process.env.PORT || 4300  name: string,
process.env.PORT || 4300  input: Record<string, unknown>,
process.env.PORT || 4300  userId?: string,
process.env.PORT || 4300): Promise<unknown> {
process.env.PORT || 4300  switch (name) {
process.env.PORT || 4300    case "list_containers": {
process.env.PORT || 4300      const list = await docker.listContainers({ all: true });
process.env.PORT || 4300      return list.map((c) => ({
process.env.PORT || 4300        id: c.Id,
process.env.PORT || 4300        name: (c.Names?.[0] || "").replace(/^\//, ""),
process.env.PORT || 4300        image: c.Image,
process.env.PORT || 4300        state: c.State,
process.env.PORT || 4300        description: c.Labels?.["iaas.description"] || undefined,
process.env.PORT || 4300        protected: !!c.Labels?.["iaas.protected"],
process.env.PORT || 4300      }));
process.env.PORT || 4300    }
process.env.PORT || 4300    case "list_functions":
process.env.PORT || 4300      return listFunctions().map((f) => ({
process.env.PORT || 4300        id: f.id,
process.env.PORT || 4300        name: f.name,
process.env.PORT || 4300        runtime: f.runtime,
process.env.PORT || 4300      }));
process.env.PORT || 4300    case "list_gateway_routes":
process.env.PORT || 4300      return listRoutes().map((r) => ({
process.env.PORT || 4300        id: r.id,
process.env.PORT || 4300        name: r.name,
process.env.PORT || 4300        targetType: r.target_type,
process.env.PORT || 4300        targetId: r.target_id,
process.env.PORT || 4300        method: r.method,
process.env.PORT || 4300        pathPattern: r.path_pattern,
process.env.PORT || 4300      }));
process.env.PORT || 4300    case "list_buckets": {
process.env.PORT || 4300      const out = await getS3Client().send(new ListBucketsCommand({}));
process.env.PORT || 4300      return (out.Buckets || []).map((b) => ({ name: b.Name }));
process.env.PORT || 4300    }
process.env.PORT || 4300    case "list_images": {
process.env.PORT || 4300      const list = await docker.listImages();
process.env.PORT || 4300      return list.map((img) => ({ id: img.Id, tags: img.RepoTags || [] }));
process.env.PORT || 4300    }
process.env.PORT || 4300    case "list_bucket_objects": {
process.env.PORT || 4300      const prefix = typeof input.prefix === "string" ? input.prefix : "";
process.env.PORT || 4300      const out = await getS3Client().send(
process.env.PORT || 4300        new ListObjectsV2Command({
process.env.PORT || 4300          Bucket: String(input.name ?? ""),
process.env.PORT || 4300          Prefix: prefix,
process.env.PORT || 4300          Delimiter: "/",
process.env.PORT || 4300        }),
process.env.PORT || 4300      );
process.env.PORT || 4300      return {
process.env.PORT || 4300        prefixes: (out.CommonPrefixes || [])
process.env.PORT || 4300          .map((p) => p.Prefix)
process.env.PORT || 4300          .filter(Boolean),
process.env.PORT || 4300        objects: (out.Contents || [])
process.env.PORT || 4300          .filter((o) => o.Key !== prefix)
process.env.PORT || 4300          .map((o) => ({
process.env.PORT || 4300            key: o.Key,
process.env.PORT || 4300            size: o.Size ?? 0,
process.env.PORT || 4300            lastModified: o.LastModified,
process.env.PORT || 4300          })),
process.env.PORT || 4300      };
process.env.PORT || 4300    }
process.env.PORT || 4300    case "read_bucket_object": {
process.env.PORT || 4300      const out = await getS3Client().send(
process.env.PORT || 4300        new GetObjectCommand({
process.env.PORT || 4300          Bucket: String(input.name ?? ""),
process.env.PORT || 4300          Key: String(input.key ?? ""),
process.env.PORT || 4300        }),
process.env.PORT || 4300      );
process.env.PORT || 4300      const content = await streamToString(out.Body);
process.env.PORT || 4300      const truncated = content.length > MAX_OBJECT_READ_CHARS;
process.env.PORT || 4300      return {
process.env.PORT || 4300        contentType: out.ContentType,
process.env.PORT || 4300        content: truncated ? content.slice(0, MAX_OBJECT_READ_CHARS) : content,
process.env.PORT || 4300        truncated,
process.env.PORT || 4300      };
process.env.PORT || 4300    }
process.env.PORT || 4300    case "read_function": {
process.env.PORT || 4300      const fn = getFunction(String(input.id ?? ""));
process.env.PORT || 4300      if (!fn) return { error: `Function "${input.id}" not found.` };
process.env.PORT || 4300      return {
process.env.PORT || 4300        id: fn.id,
process.env.PORT || 4300        name: fn.name,
process.env.PORT || 4300        runtime: fn.runtime,
process.env.PORT || 4300        code: fn.code,
process.env.PORT || 4300        packages: fn.packages || null,
process.env.PORT || 4300        entryPoint: fn.entry_point || null,
process.env.PORT || 4300        createdAt: fn.created_at,
process.env.PORT || 4300        updatedAt: fn.updated_at,
process.env.PORT || 4300      };
process.env.PORT || 4300    }
process.env.PORT || 4300    case "get_container_logs": {
process.env.PORT || 4300      const id = String(input.id ?? "");
process.env.PORT || 4300      const tailNum = Number.isFinite(input.tail) ? Number(input.tail) : 200;
process.env.PORT || 4300      const tail = Math.max(1, Math.min(500, Math.trunc(tailNum) || 200));
process.env.PORT || 4300      const buf = await docker.getContainer(id).logs({
process.env.PORT || 4300        stdout: true,
process.env.PORT || 4300        stderr: true,
process.env.PORT || 4300        tail,
process.env.PORT || 4300        timestamps: false,
process.env.PORT || 4300      });
process.env.PORT || 4300      const text = stripLogHeaders(buf as unknown as Buffer);
process.env.PORT || 4300      const MAX_LOG_CHARS = 20_000;
process.env.PORT || 4300      const truncated = text.length > MAX_LOG_CHARS;
process.env.PORT || 4300      return {
process.env.PORT || 4300        tail,
process.env.PORT || 4300        content: truncated ? text.slice(0, MAX_LOG_CHARS) : text,
process.env.PORT || 4300        truncated,
process.env.PORT || 4300      };
process.env.PORT || 4300    }
process.env.PORT || 4300    case "inspect_container": {
process.env.PORT || 4300      const info = await docker.getContainer(String(input.id ?? "")).inspect();
process.env.PORT || 4300      // Env VALUES may contain secrets — return only the variable NAMES, never
process.env.PORT || 4300      // the values, per secrets hygiene.
process.env.PORT || 4300      const envNames = (info.Config?.Env || []).map((e) => e.split("=")[0]);
process.env.PORT || 4300      return {
process.env.PORT || 4300        id: info.Id,
process.env.PORT || 4300        name: (info.Name || "").replace(/^\//, ""),
process.env.PORT || 4300        image: info.Config?.Image ?? "",
process.env.PORT || 4300        state: info.State?.Status ?? "unknown",
process.env.PORT || 4300        ports: info.NetworkSettings?.Ports
process.env.PORT || 4300          ? Object.entries(info.NetworkSettings.Ports).flatMap(
process.env.PORT || 4300              ([key, bindings]) => {
process.env.PORT || 4300                const [port, proto] = key.split("/");
process.env.PORT || 4300                return (bindings || []).map((b) => ({
process.env.PORT || 4300                  privatePort: Number(port),
process.env.PORT || 4300                  publicPort: b?.HostPort ? Number(b.HostPort) : undefined,
process.env.PORT || 4300                  type: proto || "tcp",
process.env.PORT || 4300                }));
process.env.PORT || 4300              },
process.env.PORT || 4300            )
process.env.PORT || 4300          : [],
process.env.PORT || 4300        env: envNames,
process.env.PORT || 4300        volumes: (info.Mounts || []).map((m) => ({
process.env.PORT || 4300          source: m.Source ?? "",
process.env.PORT || 4300          destination: m.Destination ?? "",
process.env.PORT || 4300          type: m.Type ?? "volume",
process.env.PORT || 4300        })),
process.env.PORT || 4300        restartPolicy: info.HostConfig?.RestartPolicy?.Name ?? "no",
process.env.PORT || 4300        labels: info.Config?.Labels ?? {},
process.env.PORT || 4300        description: info.Config?.Labels?.["iaas.description"] || undefined,
process.env.PORT || 4300        protected: !!info.Config?.Labels?.["iaas.protected"],
process.env.PORT || 4300      };
process.env.PORT || 4300    }
process.env.PORT || 4300    case "list_presets":
process.env.PORT || 4300      return PRESETS.map((p) => ({
process.env.PORT || 4300        id: p.id,
process.env.PORT || 4300        name: p.name,
process.env.PORT || 4300        category: p.category,
process.env.PORT || 4300        image: p.image,
process.env.PORT || 4300        description: p.description,
process.env.PORT || 4300        ports: (p.ports || []).map((pp) => ({
process.env.PORT || 4300          container: pp.container,
process.env.PORT || 4300          host: pp.host,
process.env.PORT || 4300        })),
process.env.PORT || 4300      }));
process.env.PORT || 4300    case "list_used_ports": {
process.env.PORT || 4300      const list = await docker.listContainers({ all: true });
process.env.PORT || 4300      const used = new Set<number>();
process.env.PORT || 4300      for (const c of list) {
process.env.PORT || 4300        for (const p of c.Ports || []) {
process.env.PORT || 4300          if (p.PublicPort) used.add(p.PublicPort);
process.env.PORT || 4300        }
process.env.PORT || 4300      }
process.env.PORT || 4300      return { ports: Array.from(used).sort((a, b) => a - b) };
process.env.PORT || 4300    }
process.env.PORT || 4300    case "list_host_build_presets": {
process.env.PORT || 4300      return listHostBuildPresets().map(
process.env.PORT || 4300        ({ name, cwd, command, args, artifacts }) => ({
process.env.PORT || 4300          name,
process.env.PORT || 4300          cwd,
process.env.PORT || 4300          command,
process.env.PORT || 4300          args,
process.env.PORT || 4300          artifacts,
process.env.PORT || 4300        }),
process.env.PORT || 4300      );
process.env.PORT || 4300    }
process.env.PORT || 4300    case "list_host_directory":
process.env.PORT || 4300      return listHostDirectory(input.sourcePath);
process.env.PORT || 4300    case "read_host_file":
process.env.PORT || 4300      return readHostTextFile(input.sourcePath);
process.env.PORT || 4300    case "list_issues": {
process.env.PORT || 4300      const limitRaw = Number(input.limit);
process.env.PORT || 4300      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.trunc(limitRaw))) : 20;
process.env.PORT || 4300      const status = typeof input.status === "string" ? input.status : undefined;
process.env.PORT || 4300      return listAssistantIssues(limit, userId, status).map(toIssueSummary);
process.env.PORT || 4300    }
process.env.PORT || 4300    case "get_issue": {
process.env.PORT || 4300      const row = getAssistantIssue(String(input.issueId ?? ""), userId);
process.env.PORT || 4300      if (!row) return { error: `Issue "${input.issueId}" not found.` };
process.env.PORT || 4300      return toIssueSummary(row);
process.env.PORT || 4300    }
process.env.PORT || 4300    case "get_consumer_status": {
process.env.PORT || 4300      const statusPath = path.join(process.cwd(), "scripts", "issue-logs", "consumer-status.json");
process.env.PORT || 4300      try {
process.env.PORT || 4300        const raw = fs.readFileSync(statusPath, "utf8");
process.env.PORT || 4300        return JSON.parse(raw);
process.env.PORT || 4300      } catch {
process.env.PORT || 4300        return { state: "unknown", error: "Status file not found — consumer may not have started yet." };
process.env.PORT || 4300      }
process.env.PORT || 4300    }
process.env.PORT || 4300    case "get_consumer_activity": {
process.env.PORT || 4300      const logDir = path.join(process.cwd(), "scripts", "issue-logs");
process.env.PORT || 4300      const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 20);
process.env.PORT || 4300      try {
process.env.PORT || 4300        const files = fs.readdirSync(logDir)
process.env.PORT || 4300          .filter(f => f.endsWith(".md"))
process.env.PORT || 4300          .sort()
process.env.PORT || 4300          .reverse()
process.env.PORT || 4300          .slice(0, limit);
process.env.PORT || 4300        return files.map(f => {
process.env.PORT || 4300          const content = fs.readFileSync(path.join(logDir, f), "utf8");
process.env.PORT || 4300          const exitMatch = content.match(/\*\*Exit code:\*\* (\d+)/);
process.env.PORT || 4300          const summaryMatch = content.match(/\*\*Summary:\*\* (.+)/);
process.env.PORT || 4300          const idMatch = content.match(/# Issue (.+)/);
process.env.PORT || 4300          return {
process.env.PORT || 4300            id: idMatch?.[1]?.trim() || f,
process.env.PORT || 4300            summary: summaryMatch?.[1]?.trim() || "unknown",
process.env.PORT || 4300            exitCode: exitMatch ? parseInt(exitMatch[1]) : null,
process.env.PORT || 4300            outcome: exitMatch ? (exitMatch[1] === "0" ? "fixed" : "failed") : "unknown",
process.env.PORT || 4300          };
process.env.PORT || 4300        });
process.env.PORT || 4300      } catch {
process.env.PORT || 4300        return [];
process.env.PORT || 4300      }
process.env.PORT || 4300    }
process.env.PORT || 4300    case "list_container_files":
process.env.PORT || 4300      return listContainerFiles(
process.env.PORT || 4300        String(input.id ?? ""),
process.env.PORT || 4300        typeof input.path === "string" ? input.path : undefined,
process.env.PORT || 4300        typeof input.maxDepth === "number" ? input.maxDepth : undefined,
process.env.PORT || 4300      );
process.env.PORT || 4300    case "probe_container_endpoint":
process.env.PORT || 4300      return probeContainerEndpoint(
process.env.PORT || 4300        String(input.id ?? ""),
process.env.PORT || 4300        typeof input.port === "number" ? input.port : Number(input.port) || 80,
process.env.PORT || 4300        typeof input.path === "string" ? input.path : undefined,
process.env.PORT || 4300        typeof input.method === "string" ? input.method : undefined,
process.env.PORT || 4300      );
process.env.PORT || 4300    case "get_container_exec_output": {
process.env.PORT || 4300      const execId = String(input.execId ?? "");
process.env.PORT || 4300      const url = `http://127.0.0.1:${process.env.PORT || 4300}/api/containers/execs/${encodeURIComponent(execId)}/output`;
process.env.PORT || 4300      const http = await import("node:http");
process.env.PORT || 4300      return new Promise((resolve, reject) => {
process.env.PORT || 4300        http.get(url, (hres) => {
process.env.PORT || 4300          let data = "";
process.env.PORT || 4300          hres.on("data", (c: string) => data += c);
process.env.PORT || 4300          hres.on("end", () => {
process.env.PORT || 4300            try { resolve(JSON.parse(data)); }
process.env.PORT || 4300            catch { reject(new Error(`Failed to parse exec output response`)); }
process.env.PORT || 4300          });
process.env.PORT || 4300        }).on("error", reject);
process.env.PORT || 4300      });
process.env.PORT || 4300    }
process.env.PORT || 4300    default:
process.env.PORT || 4300      if (DATABASE_ASSISTANT_READ_ONLY_TOOLS.has(name)) {
process.env.PORT || 4300        return executeDatabaseAssistantReadOnlyTool(name, input);
process.env.PORT || 4300      }
process.env.PORT || 4300      if (GITHUB_ASSISTANT_READ_ONLY_TOOLS.has(name)) {
process.env.PORT || 4300        return executeGithubAssistantReadOnlyTool(name, input);
process.env.PORT || 4300      }
process.env.PORT || 4300      throw new Error(`Unknown read-only tool "${name}".`);
process.env.PORT || 4300  }
process.env.PORT || 4300}
process.env.PORT || 4300
process.env.PORT || 4300async function safeExecuteReadOnly(
process.env.PORT || 4300  name: string,
process.env.PORT || 4300  input: Record<string, unknown>,
process.env.PORT || 4300  userId?: string,
process.env.PORT || 4300): Promise<{ ok: boolean; content: unknown }> {
process.env.PORT || 4300  try {
process.env.PORT || 4300    return { ok: true, content: await executeReadOnlyTool(name, input, userId) };
process.env.PORT || 4300  } catch (err) {
process.env.PORT || 4300    return { ok: false, content: { error: (err as Error).message } };
process.env.PORT || 4300  }
process.env.PORT || 4300}
process.env.PORT || 4300
process.env.PORT || 4300interface PendingAction {
process.env.PORT || 4300  id: string;
process.env.PORT || 4300  name: string;
process.env.PORT || 4300  input: Record<string, unknown>;
process.env.PORT || 4300}
process.env.PORT || 4300
process.env.PORT || 4300interface ResolvedResult {
process.env.PORT || 4300  toolUseId: string;
process.env.PORT || 4300  ok: boolean;
process.env.PORT || 4300  content: unknown;
process.env.PORT || 4300}
process.env.PORT || 4300
process.env.PORT || 4300interface TurnResponse {
process.env.PORT || 4300  messages: Anthropic.MessageParam[];
process.env.PORT || 4300  pending: PendingAction[];
process.env.PORT || 4300  /** Read-only tool calls the server already resolved on the client's behalf
process.env.PORT || 4300   *  in this same turn (only present alongside `pending` when a turn mixed
process.env.PORT || 4300   *  read-only and mutating calls — see the loop in respond() below). The
process.env.PORT || 4300   *  client must merge these into its own resolved-results accumulator and
process.env.PORT || 4300   *  send them back untouched on /confirm, since Claude expects every
process.env.PORT || 4300   *  tool_result for a turn together. */
process.env.PORT || 4300  autoResolved: ResolvedResult[];
process.env.PORT || 4300  done: boolean;
process.env.PORT || 4300  text: string;
process.env.PORT || 4300}
process.env.PORT || 4300
process.env.PORT || 4300function extractText(content: Anthropic.ContentBlock[]): string {
process.env.PORT || 4300  return content
process.env.PORT || 4300    .filter((b): b is Anthropic.TextBlock => b.type === "text")
process.env.PORT || 4300    .map((b) => b.text)
process.env.PORT || 4300    .join("\n")
process.env.PORT || 4300    .trim();
process.env.PORT || 4300}
process.env.PORT || 4300
process.env.PORT || 4300const MAX_AUTO_ROUNDS = 8;
process.env.PORT || 4300
process.env.PORT || 4300/** Thin SSE wrapper around streamTurn for the old /plan and /confirm endpoints. */
process.env.PORT || 4300async function respondStream(
process.env.PORT || 4300  messages: Anthropic.MessageParam[],
process.env.PORT || 4300  req: Request,
process.env.PORT || 4300  res: Response,
process.env.PORT || 4300): Promise<void> {
process.env.PORT || 4300  res.set({
process.env.PORT || 4300    "Content-Type": "text/event-stream",
process.env.PORT || 4300    "Cache-Control": "no-cache",
process.env.PORT || 4300    Connection: "keep-alive",
process.env.PORT || 4300  });
process.env.PORT || 4300  res.status(200);
process.env.PORT || 4300
process.env.PORT || 4300  const send = (data: Record<string, unknown>) => {
process.env.PORT || 4300    res.write(`data: ${JSON.stringify(data)}\n\n`);
process.env.PORT || 4300  };
process.env.PORT || 4300
process.env.PORT || 4300  await streamTurn(messages, (e) => {
process.env.PORT || 4300    if (e.type === "text") send({ type: "text", delta: e.delta });
process.env.PORT || 4300    else if (e.type === "turn") send(e as unknown as Record<string, unknown>);
process.env.PORT || 4300    else if (e.type === "error") send({ type: "error", error: e.error });
process.env.PORT || 4300    else if (e.type === "wait") send({ type: "wait", seconds: e.seconds, reason: e.reason, toolUseId: e.toolUseId });
process.env.PORT || 4300  });
process.env.PORT || 4300  res.end();
process.env.PORT || 4300}
process.env.PORT || 4300
process.env.PORT || 4300// Start a new turn from a natural-language prompt, optionally continuing an
process.env.PORT || 4300// existing conversation (`messages` holds everything said so far in this
process.env.PORT || 4300// session — omit it, or send [], to start a fresh conversation).
process.env.PORT || 4300assistantRouter.post("/plan", async (req: Request, res: Response) => {
process.env.PORT || 4300  try {
process.env.PORT || 4300    const { prompt, messages: prior } = req.body as {
process.env.PORT || 4300      prompt?: string;
process.env.PORT || 4300      messages?: Anthropic.MessageParam[];
process.env.PORT || 4300    };
process.env.PORT || 4300    if (!prompt?.trim()) {
process.env.PORT || 4300      res.status(400).json({ error: "A prompt is required." });
process.env.PORT || 4300      return;
process.env.PORT || 4300    }
process.env.PORT || 4300    const messages: Anthropic.MessageParam[] = [
process.env.PORT || 4300      ...(prior ?? []),
process.env.PORT || 4300      { role: "user", content: prompt.trim() },
process.env.PORT || 4300    ];
process.env.PORT || 4300    await respondStream(messages, req, res);
process.env.PORT || 4300  } catch (err) {
process.env.PORT || 4300    // If headers haven't been sent yet, this is a pre-stream error (e.g.
process.env.PORT || 4300    // body parse failure). Otherwise the error was already sent via SSE.
process.env.PORT || 4300    if (!res.headersSent) {
process.env.PORT || 4300      res.status(500).json({ error: (err as Error).message });
process.env.PORT || 4300    }
process.env.PORT || 4300  }
process.env.PORT || 4300});
process.env.PORT || 4300
process.env.PORT || 4300// Continue a plan after the user has confirmed/declined the pending tool
process.env.PORT || 4300// call(s) and (for confirmed ones) the real Dockyard API has been invoked.
process.env.PORT || 4300assistantRouter.post("/confirm", async (req: Request, res: Response) => {
process.env.PORT || 4300  try {
process.env.PORT || 4300    const { messages, results } = req.body as {
process.env.PORT || 4300      messages?: Anthropic.MessageParam[];
process.env.PORT || 4300      results?: { toolUseId: string; ok: boolean; content: unknown }[];
process.env.PORT || 4300    };
process.env.PORT || 4300    if (!messages?.length || !results?.length) {
process.env.PORT || 4300      res.status(400).json({ error: "messages and results are required." });
process.env.PORT || 4300      return;
process.env.PORT || 4300    }
process.env.PORT || 4300    messages.push({
process.env.PORT || 4300      role: "user",
process.env.PORT || 4300      content: results.map((r) => ({
process.env.PORT || 4300        type: "tool_result" as const,
process.env.PORT || 4300        tool_use_id: r.toolUseId,
process.env.PORT || 4300        content:
process.env.PORT || 4300          typeof r.content === "string"
process.env.PORT || 4300            ? r.content
process.env.PORT || 4300            : JSON.stringify(r.content ?? {}),
process.env.PORT || 4300        is_error: !r.ok,
process.env.PORT || 4300      })),
process.env.PORT || 4300    });
process.env.PORT || 4300    await respondStream(messages, req, res);
process.env.PORT || 4300  } catch (err) {
process.env.PORT || 4300    if (!res.headersSent) {
process.env.PORT || 4300      res.status(500).json({ error: (err as Error).message });
process.env.PORT || 4300    }
process.env.PORT || 4300  }
process.env.PORT || 4300});
process.env.PORT || 4300
process.env.PORT || 4300// ---------------------------------------------------------------------------
process.env.PORT || 4300// Named, persisted Ask Dockyard sessions. `state` is opaque here — the
process.env.PORT || 4300// client owns its shape (conversation history, action log, pending
process.env.PORT || 4300// confirmations) and this layer just stores/returns it verbatim.
process.env.PORT || 4300// ---------------------------------------------------------------------------
process.env.PORT || 4300
process.env.PORT || 4300/** Ask Claude for a short, friendly title summarizing a conversation. Used
process.env.PORT || 4300 *  to name a new session instead of truncating the user's first message. Runs
process.env.PORT || 4300 *  on Haiku (cheap/fast) with a tight token cap; any failure is caught by the
process.env.PORT || 4300 *  caller, which falls back to the truncated-first-message heuristic. */
process.env.PORT || 4300assistantRouter.post("/title", async (req: Request, res: Response) => {
process.env.PORT || 4300  const { prompt, reply } = req.body as { prompt?: string; reply?: string };
process.env.PORT || 4300  const userText = (prompt || "").trim();
process.env.PORT || 4300  if (!userText) {
process.env.PORT || 4300    res.status(400).json({ error: "A prompt is required." });
process.env.PORT || 4300    return;
process.env.PORT || 4300  }
process.env.PORT || 4300  try {
process.env.PORT || 4300    let title: string | null = null;
process.env.PORT || 4300
process.env.PORT || 4300    if (PROVIDER === 'deepseek') {
process.env.PORT || 4300      const deepseekRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
process.env.PORT || 4300        method: 'POST',
process.env.PORT || 4300        headers: {
process.env.PORT || 4300          'Content-Type': 'application/json',
process.env.PORT || 4300          Authorization: `Bearer ${resolveApiKey('deepseek')}`,
process.env.PORT || 4300        },
process.env.PORT || 4300        body: JSON.stringify({
process.env.PORT || 4300          model: 'deepseek-chat',
process.env.PORT || 4300          max_tokens: 32,
process.env.PORT || 4300          messages: [
process.env.PORT || 4300            {
process.env.PORT || 4300              role: 'user',
process.env.PORT || 4300              content: `Summarize this conversation in 3-6 words, title case, no quotes or punctuation:\n\nUser: ${userText}\nAssistant: ${(reply || "").slice(0, 600)}`,
process.env.PORT || 4300            },
process.env.PORT || 4300          ],
process.env.PORT || 4300        }),
process.env.PORT || 4300      });
process.env.PORT || 4300      const body = await deepseekRes.json() as { choices?: { message?: { content?: string } }[] };
process.env.PORT || 4300      title = body.choices?.[0]?.message?.content?.trim() ?? null;
process.env.PORT || 4300    } else {
process.env.PORT || 4300      const out = await client.messages.create({
process.env.PORT || 4300        model: TITLE_MODEL,
process.env.PORT || 4300        max_tokens: 32,
process.env.PORT || 4300        system: "Generate a short, descriptive title summarizing what the user asked for. Reply with only the title.",
process.env.PORT || 4300        messages: [
process.env.PORT || 4300          {
process.env.PORT || 4300            role: "user",
process.env.PORT || 4300            content: `User asked: ${userText}\n\nAssistant replied: ${(reply || "").slice(0, 600)}`,
process.env.PORT || 4300          },
process.env.PORT || 4300        ],
process.env.PORT || 4300      });
process.env.PORT || 4300      title = extractText(out.content).replace(/\s+/g, " ").trim().slice(0, 80);
process.env.PORT || 4300    }
process.env.PORT || 4300
process.env.PORT || 4300    res.json({ name: title || userText.slice(0, 60) });
process.env.PORT || 4300  } catch (err) {
process.env.PORT || 4300    res.status(502).json({ error: (err as Error).message });
process.env.PORT || 4300  }
process.env.PORT || 4300});
process.env.PORT || 4300
process.env.PORT || 4300function toIssueSummary(r: import("../db.js").AssistantIssueRow) {
process.env.PORT || 4300  let details: unknown = {};
process.env.PORT || 4300  try { details = JSON.parse(r.details_json); } catch { /* ok */ }
process.env.PORT || 4300  return {
process.env.PORT || 4300    id: r.id,
process.env.PORT || 4300    summary: r.summary,
process.env.PORT || 4300    category: r.category,
process.env.PORT || 4300    details,
process.env.PORT || 4300    createdAt: r.created_at,
process.env.PORT || 4300    status: r.status,
process.env.PORT || 4300    resolution: r.resolution,
process.env.PORT || 4300    resolvedBy: r.resolved_by,
process.env.PORT || 4300  };
process.env.PORT || 4300}
process.env.PORT || 4300
process.env.PORT || 4300function toSessionSummary(r: {
process.env.PORT || 4300  id: string;
process.env.PORT || 4300  name: string;
process.env.PORT || 4300  created_at: string;
process.env.PORT || 4300  updated_at: string;
process.env.PORT || 4300}) {
process.env.PORT || 4300  return {
process.env.PORT || 4300    id: r.id,
process.env.PORT || 4300    name: r.name,
process.env.PORT || 4300    createdAt: r.created_at,
process.env.PORT || 4300    updatedAt: r.updated_at,
process.env.PORT || 4300    running: sessionRegistry.has(r.id) && (sessionRegistry.get(r.id)?.isRunning ?? false),
process.env.PORT || 4300  };
process.env.PORT || 4300}
process.env.PORT || 4300
process.env.PORT || 4300function toSessionFull(r: import("../db.js").AssistantSessionRow) {
process.env.PORT || 4300  let state: unknown = {};
process.env.PORT || 4300  try {
process.env.PORT || 4300    state = JSON.parse(r.state);
process.env.PORT || 4300  } catch {
process.env.PORT || 4300    // Corrupt/empty state — fall back to an empty object rather than 500ing.
process.env.PORT || 4300  }
process.env.PORT || 4300  return { ...toSessionSummary(r), state };
process.env.PORT || 4300}
process.env.PORT || 4300
process.env.PORT || 4300assistantRouter.get("/sessions", (req: Request, res: Response) => {
process.env.PORT || 4300  try {
process.env.PORT || 4300    const userId = getAuthUser(req)?.userId;
process.env.PORT || 4300    const q = typeof req.query.q === "string" ? req.query.q : undefined;
process.env.PORT || 4300    res.json(listAssistantSessions(userId, q).map(toSessionSummary));
process.env.PORT || 4300  } catch (err) {
process.env.PORT || 4300    res.status(500).json({ error: (err as Error).message });
process.env.PORT || 4300  }
process.env.PORT || 4300});
process.env.PORT || 4300
process.env.PORT || 4300assistantRouter.get("/sessions/:id", (req: Request, res: Response) => {
process.env.PORT || 4300  try {
process.env.PORT || 4300    const userId = getAuthUser(req)?.userId;
process.env.PORT || 4300    const row = getAssistantSession(req.params.id, userId);
process.env.PORT || 4300    if (!row) {
process.env.PORT || 4300      res.status(404).json({ error: "Session not found." });
process.env.PORT || 4300      return;
process.env.PORT || 4300    }
process.env.PORT || 4300    res.json(toSessionFull(row));
process.env.PORT || 4300  } catch (err) {
process.env.PORT || 4300    res.status(500).json({ error: (err as Error).message });
process.env.PORT || 4300  }
process.env.PORT || 4300});
process.env.PORT || 4300
process.env.PORT || 4300assistantRouter.post("/sessions", (req: Request, res: Response) => {
process.env.PORT || 4300  try {
process.env.PORT || 4300    const userId = getAuthUser(req)?.userId;
process.env.PORT || 4300    const { name, state } = req.body as { name?: string; state?: unknown };
process.env.PORT || 4300    if (!name?.trim()) {
process.env.PORT || 4300      res.status(400).json({ error: "A session name is required." });
process.env.PORT || 4300      return;
process.env.PORT || 4300    }
process.env.PORT || 4300    const id = `asn-${Math.random().toString(36).slice(2, 8)}`;
process.env.PORT || 4300    const row = createAssistantSession(
process.env.PORT || 4300      id,
process.env.PORT || 4300      name.trim(),
process.env.PORT || 4300      JSON.stringify(state ?? {}),
process.env.PORT || 4300      userId,
process.env.PORT || 4300    );
process.env.PORT || 4300    res.status(201).json(toSessionFull(row));
process.env.PORT || 4300  } catch (err) {
process.env.PORT || 4300    res.status(500).json({ error: (err as Error).message });
process.env.PORT || 4300  }
process.env.PORT || 4300});
process.env.PORT || 4300
process.env.PORT || 4300assistantRouter.put("/sessions/:id", (req: Request, res: Response) => {
process.env.PORT || 4300  try {
process.env.PORT || 4300    const { name, state } = req.body as { name?: string; state?: unknown };
process.env.PORT || 4300    const row = updateAssistantSession(req.params.id, {
process.env.PORT || 4300      name: name?.trim() || undefined,
process.env.PORT || 4300      state: state !== undefined ? JSON.stringify(state) : undefined,
process.env.PORT || 4300    });
process.env.PORT || 4300    if (!row) {
process.env.PORT || 4300      res.status(404).json({ error: "Session not found." });
process.env.PORT || 4300      return;
process.env.PORT || 4300    }
process.env.PORT || 4300    res.json(toSessionFull(row));
process.env.PORT || 4300  } catch (err) {
process.env.PORT || 4300    res.status(500).json({ error: (err as Error).message });
process.env.PORT || 4300  }
process.env.PORT || 4300});
process.env.PORT || 4300
process.env.PORT || 4300assistantRouter.delete("/sessions/:id", (req: Request, res: Response) => {
process.env.PORT || 4300  try {
process.env.PORT || 4300    const deleted = deleteAssistantSession(req.params.id);
process.env.PORT || 4300    if (!deleted) {
process.env.PORT || 4300      res.status(404).json({ error: "Session not found." });
process.env.PORT || 4300      return;
process.env.PORT || 4300    }
process.env.PORT || 4300    res.json({ ok: true });
process.env.PORT || 4300  } catch (err) {
process.env.PORT || 4300    res.status(500).json({ error: (err as Error).message });
process.env.PORT || 4300  }
process.env.PORT || 4300});
process.env.PORT || 4300
process.env.PORT || 4300// ---------------------------------------------------------------------------
process.env.PORT || 4300// Assistant issue reporting
process.env.PORT || 4300// ---------------------------------------------------------------------------
process.env.PORT || 4300
process.env.PORT || 4300assistantRouter.get("/issues/counts", (req: Request, res: Response) => {
process.env.PORT || 4300  try {
process.env.PORT || 4300    const userId = getAuthUser(req)?.userId;
process.env.PORT || 4300    const byStatus = countAssistantIssuesByStatus(userId);
process.env.PORT || 4300    res.json({
process.env.PORT || 4300      open: byStatus.open ?? 0,
process.env.PORT || 4300      resolved: (byStatus.resolved ?? 0) + (byStatus.closed ?? 0),
process.env.PORT || 4300      byStatus,
process.env.PORT || 4300    });
process.env.PORT || 4300  } catch (err) {
process.env.PORT || 4300    res.status(500).json({ error: (err as Error).message });
process.env.PORT || 4300  }
process.env.PORT || 4300});
process.env.PORT || 4300
process.env.PORT || 4300assistantRouter.get("/issues", (req: Request, res: Response) => {
process.env.PORT || 4300  try {
process.env.PORT || 4300    const userId = getAuthUser(req)?.userId;
process.env.PORT || 4300    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
process.env.PORT || 4300    const status = typeof req.query.status === "string" ? req.query.status : undefined;
process.env.PORT || 4300    res.json(listAssistantIssues(limit, userId, status).map(toIssueSummary));
process.env.PORT || 4300  } catch (err) {
process.env.PORT || 4300    res.status(500).json({ error: (err as Error).message });
process.env.PORT || 4300  }
process.env.PORT || 4300});
process.env.PORT || 4300
process.env.PORT || 4300assistantRouter.post("/issues", (req: Request, res: Response) => {
process.env.PORT || 4300  try {
process.env.PORT || 4300    const userId = getAuthUser(req)?.userId;
process.env.PORT || 4300    const { summary, category, details } = req.body as {
process.env.PORT || 4300      summary?: string;
process.env.PORT || 4300      category?: string;
process.env.PORT || 4300      details?: Record<string, unknown>;
process.env.PORT || 4300    };
process.env.PORT || 4300    if (!summary?.trim()) {
process.env.PORT || 4300      res.status(400).json({ error: "A summary is required." });
process.env.PORT || 4300      return;
process.env.PORT || 4300    }
process.env.PORT || 4300    const { row } = createAssistantIssue(
process.env.PORT || 4300      { summary: summary.trim(), category, details },
process.env.PORT || 4300      userId,
process.env.PORT || 4300    );
process.env.PORT || 4300    const payload = toIssueSummary(row);
process.env.PORT || 4300
process.env.PORT || 4300    // Fire-and-forget webhook so external consumers (Redis queues, Slack, etc.)
process.env.PORT || 4300    // can react in real time without the assistant needing to call both
process.env.PORT || 4300    // report_issue and the push endpoint manually.
process.env.PORT || 4300    const webhookUrl = process.env.ISSUE_WEBHOOK_URL;
process.env.PORT || 4300    if (webhookUrl) {
process.env.PORT || 4300      fetch(webhookUrl, {
process.env.PORT || 4300        method: "POST",
process.env.PORT || 4300        headers: { "Content-Type": "application/json" },
process.env.PORT || 4300        body: JSON.stringify({ id: payload.id, summary: payload.summary, category: payload.category, details: payload.details }),
process.env.PORT || 4300      }).catch(() => { /* best-effort */ });
process.env.PORT || 4300    }
process.env.PORT || 4300
process.env.PORT || 4300    res.status(201).json(payload);
process.env.PORT || 4300  } catch (err) {
process.env.PORT || 4300    res.status(500).json({ error: (err as Error).message });
process.env.PORT || 4300  }
process.env.PORT || 4300});
process.env.PORT || 4300
process.env.PORT || 4300assistantRouter.delete("/issues/:id", (req: Request, res: Response) => {
process.env.PORT || 4300  try {
process.env.PORT || 4300    const userId = getAuthUser(req)?.userId;
process.env.PORT || 4300    const deleted = deleteAssistantIssue(req.params.id, userId);
process.env.PORT || 4300    if (!deleted) {
process.env.PORT || 4300      res.status(404).json({ error: "Issue not found." });
process.env.PORT || 4300      return;
process.env.PORT || 4300    }
process.env.PORT || 4300    res.json({ ok: true });
process.env.PORT || 4300  } catch (err) {
process.env.PORT || 4300    res.status(500).json({ error: (err as Error).message });
process.env.PORT || 4300  }
process.env.PORT || 4300});
process.env.PORT || 4300
process.env.PORT || 4300assistantRouter.patch("/issues/:id", (req: Request, res: Response) => {
process.env.PORT || 4300  try {
process.env.PORT || 4300    const userId = getAuthUser(req)?.userId;
process.env.PORT || 4300    const { status, resolution, resolvedBy } = req.body as {
process.env.PORT || 4300      status?: string;
process.env.PORT || 4300      resolution?: string;
process.env.PORT || 4300      resolvedBy?: string;
process.env.PORT || 4300    };
process.env.PORT || 4300    if (status !== undefined && !ASSISTANT_ISSUE_STATUSES.includes(status as (typeof ASSISTANT_ISSUE_STATUSES)[number])) {
process.env.PORT || 4300      res.status(400).json({ error: `Invalid status. Must be one of: ${ASSISTANT_ISSUE_STATUSES.join(", ")}.` });
process.env.PORT || 4300      return;
process.env.PORT || 4300    }
process.env.PORT || 4300    const row = updateAssistantIssue(req.params.id, { status, resolution, resolvedBy }, userId);
process.env.PORT || 4300    if (!row) {
process.env.PORT || 4300      res.status(404).json({ error: "Issue not found." });
process.env.PORT || 4300      return;
process.env.PORT || 4300    }
process.env.PORT || 4300    res.json(toIssueSummary(row));
process.env.PORT || 4300  } catch (err) {
process.env.PORT || 4300    res.status(500).json({ error: (err as Error).message });
process.env.PORT || 4300  }
process.env.PORT || 4300});
process.env.PORT || 4300
process.env.PORT || 4300assistantRouter.delete("/issues", (req: Request, res: Response) => {
process.env.PORT || 4300  try {
process.env.PORT || 4300    const userId = getAuthUser(req)?.userId;
process.env.PORT || 4300    const category = typeof req.query.category === "string" ? req.query.category : undefined;
process.env.PORT || 4300    const count = clearAssistantIssues(userId, category);
process.env.PORT || 4300    res.json({ ok: true, deleted: count });
process.env.PORT || 4300  } catch (err) {
process.env.PORT || 4300    res.status(500).json({ error: (err as Error).message });
process.env.PORT || 4300  }
process.env.PORT || 4300});
process.env.PORT || 4300
process.env.PORT || 4300// ── Session Runner endpoints ─────────────────────────────────────────────────
process.env.PORT || 4300import { getOrCreateSession, type SessionEvent } from "../sessionRunner.js";
process.env.PORT || 4300
process.env.PORT || 4300/** Refactored streaming: writes events to a callback instead of directly to `res`.
process.env.PORT || 4300 *  Used by both the old HTTP endpoints (via respondStream wrapper) and the new
process.env.PORT || 4300 *  SessionRunner. */
process.env.PORT || 4300async function streamTurn(
process.env.PORT || 4300  messages: Anthropic.MessageParam[],
process.env.PORT || 4300  onEvent: (e: SessionEvent) => void,
process.env.PORT || 4300  signal?: AbortSignal,
process.env.PORT || 4300): Promise<void> {
process.env.PORT || 4300  let aborted = false;
process.env.PORT || 4300  const onAbort = () => { aborted = true; };
process.env.PORT || 4300  signal?.addEventListener("abort", onAbort, { once: true });
process.env.PORT || 4300
process.env.PORT || 4300  try {
process.env.PORT || 4300    for (let round = 0; round < MAX_AUTO_ROUNDS; round++) {
process.env.PORT || 4300      if (aborted) return;
process.env.PORT || 4300
process.env.PORT || 4300      const stream = client.messages.stream({
process.env.PORT || 4300        model: MAIN_MODEL,
process.env.PORT || 4300        max_tokens: 32000,
process.env.PORT || 4300        system: SYSTEM,
process.env.PORT || 4300        tools,
process.env.PORT || 4300        messages,
process.env.PORT || 4300      });
process.env.PORT || 4300
process.env.PORT || 4300      stream.on("text", (delta) => {
process.env.PORT || 4300        if (!aborted) onEvent({ type: "text", delta });
process.env.PORT || 4300      });
process.env.PORT || 4300
process.env.PORT || 4300      let finalMessage: Anthropic.Message;
process.env.PORT || 4300      try {
process.env.PORT || 4300        finalMessage = await stream.finalMessage();
process.env.PORT || 4300      } catch (err) {
process.env.PORT || 4300        if (aborted) return;
process.env.PORT || 4300        throw err;
process.env.PORT || 4300      }
process.env.PORT || 4300      if (aborted) return;
process.env.PORT || 4300
process.env.PORT || 4300      messages.push({ role: "assistant", content: finalMessage.content });
process.env.PORT || 4300
process.env.PORT || 4300      const toolUses = finalMessage.content.filter(
process.env.PORT || 4300        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
process.env.PORT || 4300      );
process.env.PORT || 4300
process.env.PORT || 4300      // Handle `wait` tool calls before any other tool processing: emit an
process.env.PORT || 4300      // SSE wait event so the client shows a countdown, sleep for the
process.env.PORT || 4300      // requested duration, then add a synthetic tool_result so the model
process.env.PORT || 4300      // sees the wait as completed.  Wait calls run sequentially (not in
process.env.PORT || 4300      // parallel) so multiple waits stack their sleep time.
process.env.PORT || 4300      const waitCalls = toolUses.filter((b) => b.name === "wait");
process.env.PORT || 4300      if (waitCalls.length > 0) {
process.env.PORT || 4300        for (const w of waitCalls) {
process.env.PORT || 4300          const input = w.input as Record<string, unknown>;
process.env.PORT || 4300          const seconds = Math.max(1, Math.min(60, Number(input.seconds) || 10));
process.env.PORT || 4300          const reason = typeof input.reason === "string" ? input.reason : undefined;
process.env.PORT || 4300          onEvent({ type: "wait", seconds, reason, toolUseId: w.id });
process.env.PORT || 4300          await new Promise((r) => setTimeout(r, seconds * 1000));
process.env.PORT || 4300          messages.push({
process.env.PORT || 4300            role: "user",
process.env.PORT || 4300            content: [
process.env.PORT || 4300              {
process.env.PORT || 4300                type: "tool_result" as const,
process.env.PORT || 4300                tool_use_id: w.id,
process.env.PORT || 4300                content: JSON.stringify({ waited: seconds, reason: reason ?? null }),
process.env.PORT || 4300              },
process.env.PORT || 4300            ],
process.env.PORT || 4300          });
process.env.PORT || 4300        }
process.env.PORT || 4300      }
process.env.PORT || 4300
process.env.PORT || 4300      // Filter out wait calls — they have already been handled above.
process.env.PORT || 4300      const activeTools = toolUses.filter((b) => b.name !== "wait");
process.env.PORT || 4300      if (waitCalls.length > 0 && activeTools.length === 0) {
process.env.PORT || 4300        // Wait was the only tool call — loop back to the model.
process.env.PORT || 4300        continue;
process.env.PORT || 4300      }
process.env.PORT || 4300
process.env.PORT || 4300      const readOnlyCalls = activeTools.filter((b) => READ_ONLY_TOOLS.has(b.name));
process.env.PORT || 4300      const mutatingCalls = activeTools.filter(
process.env.PORT || 4300        (b) => !READ_ONLY_TOOLS.has(b.name),
process.env.PORT || 4300      );
process.env.PORT || 4300
process.env.PORT || 4300      if (activeTools.length === 0) {
process.env.PORT || 4300        onEvent({
process.env.PORT || 4300          type: "turn",
process.env.PORT || 4300          messages,
process.env.PORT || 4300          pending: [],
process.env.PORT || 4300          autoResolved: [],
process.env.PORT || 4300          done: true,
process.env.PORT || 4300          text: extractText(finalMessage.content),
process.env.PORT || 4300        });
process.env.PORT || 4300        return;
process.env.PORT || 4300      }
process.env.PORT || 4300
process.env.PORT || 4300      if (mutatingCalls.length > 0) {
process.env.PORT || 4300        const autoResolved: ResolvedResult[] = await Promise.all(
process.env.PORT || 4300          readOnlyCalls.map(async (b) => {
process.env.PORT || 4300            const r = await safeExecuteReadOnly(b.name, b.input as Record<string, unknown>);
process.env.PORT || 4300            return { toolUseId: b.id, ok: r.ok, content: r.content };
process.env.PORT || 4300          }),
process.env.PORT || 4300        );
process.env.PORT || 4300        onEvent({
process.env.PORT || 4300          type: "turn",
process.env.PORT || 4300          messages,
process.env.PORT || 4300          pending: mutatingCalls.map((b) => ({ id: b.id, name: b.name, input: b.input })),
process.env.PORT || 4300          autoResolved,
process.env.PORT || 4300          done: false,
process.env.PORT || 4300          text: extractText(finalMessage.content),
process.env.PORT || 4300        });
process.env.PORT || 4300        return;
process.env.PORT || 4300      }
process.env.PORT || 4300
process.env.PORT || 4300      // All tools are read-only — execute inline and loop.
process.env.PORT || 4300      const results = await Promise.all(
process.env.PORT || 4300        readOnlyCalls.map(async (b) => {
process.env.PORT || 4300          const r = await safeExecuteReadOnly(b.name, b.input as Record<string, unknown>);
process.env.PORT || 4300          return {
process.env.PORT || 4300            type: "tool_result" as const,
process.env.PORT || 4300            tool_use_id: b.id,
process.env.PORT || 4300            content: typeof r.content === "string" ? r.content : JSON.stringify(r.content ?? {}),
process.env.PORT || 4300            is_error: !r.ok,
process.env.PORT || 4300          };
process.env.PORT || 4300        }),
process.env.PORT || 4300      );
process.env.PORT || 4300      messages.push({ role: "user", content: results });
process.env.PORT || 4300    }
process.env.PORT || 4300  } finally {
process.env.PORT || 4300    signal?.removeEventListener("abort", onAbort);
process.env.PORT || 4300  }
process.env.PORT || 4300}
process.env.PORT || 4300
process.env.PORT || 4300/** SSE subscription — streams live session events to one client. */
process.env.PORT || 4300assistantRouter.get("/sessions/:id/stream", (req: Request, res: Response) => {
process.env.PORT || 4300  const userId = getAuthUser(req)?.userId;
process.env.PORT || 4300  const sessionId = req.params.id;
process.env.PORT || 4300
process.env.PORT || 4300  // Load the session from DB to get its name
process.env.PORT || 4300  const row = getAssistantSession(sessionId, userId);
process.env.PORT || 4300  if (!row) {
process.env.PORT || 4300    res.status(404).json({ error: "Session not found." });
process.env.PORT || 4300    return;
process.env.PORT || 4300  }
process.env.PORT || 4300
process.env.PORT || 4300  const runner = getOrCreateSession(sessionId, row.name, userId, streamTurn, client);
process.env.PORT || 4300
process.env.PORT || 4300  res.set({
process.env.PORT || 4300    "Content-Type": "text/event-stream",
process.env.PORT || 4300    "Cache-Control": "no-cache",
process.env.PORT || 4300    Connection: "keep-alive",
process.env.PORT || 4300  });
process.env.PORT || 4300  res.status(200);
process.env.PORT || 4300
process.env.PORT || 4300  const send = (data: Record<string, unknown>) => {
process.env.PORT || 4300    res.write(`data: ${JSON.stringify(data)}\n\n`);
process.env.PORT || 4300  };
process.env.PORT || 4300
process.env.PORT || 4300  // Send current state as catch-up
process.env.PORT || 4300  const current = getAssistantSession(sessionId, userId);
process.env.PORT || 4300  if (current) {
process.env.PORT || 4300    send({ type: "state", ...JSON.parse(current.state) });
process.env.PORT || 4300  }
process.env.PORT || 4300  send({ type: "status", running: runner.isRunning });
process.env.PORT || 4300
process.env.PORT || 4300  // Subscribe to live events
process.env.PORT || 4300  const onEvent = (e: SessionEvent) => { send(e as unknown as Record<string, unknown>); };
process.env.PORT || 4300
process.env.PORT || 4300  runner.on("event", onEvent);
process.env.PORT || 4300
process.env.PORT || 4300  const onClose = () => {
process.env.PORT || 4300    runner.off("event", onEvent);
process.env.PORT || 4300  };
process.env.PORT || 4300  res.on("close", onClose);
process.env.PORT || 4300});
process.env.PORT || 4300
process.env.PORT || 4300/** Send a user message (and optional tool results) to a session. */
process.env.PORT || 4300assistantRouter.post("/sessions/:id/send", async (req: Request, res: Response) => {
process.env.PORT || 4300  try {
process.env.PORT || 4300    const userId = getAuthUser(req)?.userId;
process.env.PORT || 4300    const sessionId = req.params.id;
process.env.PORT || 4300    const { prompt, results: toolResults, state } = req.body as {
process.env.PORT || 4300      prompt?: string;
process.env.PORT || 4300      results?: { toolUseId: string; ok: boolean; content: unknown }[];
process.env.PORT || 4300      state?: { messages: unknown[]; log: unknown[]; pending: unknown[]; resolved: unknown[] };
process.env.PORT || 4300    };
process.env.PORT || 4300
process.env.PORT || 4300    if (!prompt?.trim() && !toolResults?.length) {
process.env.PORT || 4300      res.status(400).json({ error: "A prompt or tool results are required." });
process.env.PORT || 4300      return;
process.env.PORT || 4300    }
process.env.PORT || 4300
process.env.PORT || 4300    const row = getAssistantSession(sessionId, userId);
process.env.PORT || 4300    if (!row) {
process.env.PORT || 4300      res.status(404).json({ error: "Session not found." });
process.env.PORT || 4300      return;
process.env.PORT || 4300    }
process.env.PORT || 4300
process.env.PORT || 4300    const runner = getOrCreateSession(sessionId, row.name, userId, streamTurn, client);
process.env.PORT || 4300
process.env.PORT || 4300    // Start processing in the background — client subscribes via /stream.
process.env.PORT || 4300    const sessionState = state || JSON.parse(row.state);
process.env.PORT || 4300    runner.send(sessionState, prompt?.trim() || undefined, toolResults);
process.env.PORT || 4300
process.env.PORT || 4300    // Persist the updated state immediately
process.env.PORT || 4300    if (state) {
process.env.PORT || 4300      updateAssistantSession(sessionId, { state: JSON.stringify(state) });
process.env.PORT || 4300    }
process.env.PORT || 4300
process.env.PORT || 4300    res.json({ ok: true, sessionId });
process.env.PORT || 4300  } catch (err) {
process.env.PORT || 4300    res.status(500).json({ error: (err as Error).message });
process.env.PORT || 4300  }
process.env.PORT || 4300});
process.env.PORT || 4300
process.env.PORT || 4300/** Abort the current turn in a session. */
process.env.PORT || 4300assistantRouter.post("/sessions/:id/abort", (req: Request, res: Response) => {
process.env.PORT || 4300  const runner = sessionRegistry.get(req.params.id);
process.env.PORT || 4300  if (runner) runner.abort();
process.env.PORT || 4300  res.json({ ok: true });
process.env.PORT || 4300});
