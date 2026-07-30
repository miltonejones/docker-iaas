import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { getAuthUser } from "../auth.js";
import Anthropic from "@anthropic-ai/sdk";
import { stripLogHeaders } from "./containers.js";
import {
  listContainerFiles,
  probeContainerEndpoint,
  readFile,
} from "./containers.js";
import {
  getAllUserSettings,
} from "../db.js";
import {
  listAssistantSessions,
  getAssistantSession,
  createAssistantSession,
  updateAssistantSession,
  deleteAssistantSession,
} from "../db/assistantSessions.js";
import {
  listAssistantIssues,
  getAssistantIssue,
  createAssistantIssue,
  updateAssistantIssue,
  deleteAssistantIssue,
  clearAssistantIssues,
  countAssistantIssuesByStatus,
  ASSISTANT_ISSUE_STATUSES,
} from "../db/assistantIssues.js";
import { sessionRegistry } from "../sessionRunner.js";
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
import * as containerService from "../services/containers.js";
import * as bucketService from "../services/buckets.js";
import * as gatewayService from "../services/gateway.js";
import * as lambdaService from "../services/lambda.js";
import * as imageService from "../services/images.js";
import * as systemService from "../services/system.js";
import * as projectService from "../services/projects.js";
import { get as getAssistant } from "../services/assistants.js";
import * as volumeService from "../services/volumes.js";

export const assistantRouter = Router();

type AssistantProvider = 'anthropic' | 'deepseek';

/** Resolve the API key for a provider, checking user settings first, then
 *  Docker secrets (the system default). */
function resolveApiKeyForUser(userId: string, provider: AssistantProvider): string | undefined {
  const settings = getAllUserSettings(userId);
  const settingKey = provider === 'deepseek' ? 'deepseek_api_key' : 'anthropic_api_key';
  if (settings[settingKey]) return settings[settingKey];

  // Fall back to system-level Docker secrets / env vars.
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
    } catch { /* try next */ }
  }
  return undefined;
}

function resolveProviderForUser(userId: string): AssistantProvider {
  const settings = getAllUserSettings(userId);
  if (settings.assistant_provider === 'deepseek') return 'deepseek';
  return process.env.ASSISTANT_PROVIDER === 'deepseek' ? 'deepseek' : 'anthropic';
}

interface AssistantClient {
  client: Anthropic;
  provider: AssistantProvider;
  mainModel: string;
  titleModel: string;
}

/** Build an Anthropic client using the given user's credentials.  Falls back
 *  to the system-level Docker secrets if the user hasn't configured keys. */
function getAssistantClient(userId: string): AssistantClient | null {
  const provider = resolveProviderForUser(userId);
  const apiKey = resolveApiKeyForUser(userId, provider);
  if (!apiKey) return null;

  const mainModel = provider === 'deepseek'
    ? process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro'
    : process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
  const titleModel = provider === 'deepseek'
    ? process.env.DEEPSEEK_TITLE_MODEL || 'deepseek-v4-flash'
    : process.env.ANTHROPIC_TITLE_MODEL || 'claude-haiku-4-5';

  return {
    client: new Anthropic({
      apiKey,
      baseURL: provider === 'deepseek' ? 'https://api.deepseek.com/anthropic' : 'https://api.anthropic.com',
    }),
    provider,
    mainModel,
    titleModel,
  };
}

const SYSTEM = `You are the Dockyard.ai assistant. You translate a user's natural-language request into tool calls that manage Lambda functions, Gateway routes, containers, Docker images, storage buckets, projects, and saved MySQL/MongoDB connections.

Projects organize resources — containers, functions, gateway routes, and buckets can all be assigned to a project. Use list_projects to see existing projects and their resource counts. When creating a resource, pass projectId to assign it. When listing resources, pass projectId to filter by project. If the user mentions a project by name, call list_projects first to resolve the name to an ID.

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
- Containers launched through this assistant can run confirmed commands with execute_container_command. Pass command as an argument array, never as a shell string: for example, ["npm", "ci"] or ["npx", "ng", "build"]. Set workingDir when the project is not in the container's default working directory. To start a long-running server (e.g. a Node.js API), set background: true so the command runs detached and doesn't block — the tool returns immediately. IMPORTANT: background execs do NOT capture stdout/stderr; use get_container_logs for the container's primary process output, or run commands non-background to see their output inline. For one-shot commands whose output you need (builds, installs, file listings), always run them non-background. To read a text file inside a container (config, build output, etc.) without running a shell command, use read_container_file — it extracts the file directly via Docker's archive API. To copy files or directories between containers (e.g. moving build artifacts from a build container to a serving container), use copy_to_container with sourceType="container", sourceContainerId, sourcePath. This uses tar streaming under the hood so it handles binaries and large files efficiently; it also works from buckets with sourceType="bucket", sourceBucket, sourceKey. To update environment variables on a running container, use update_container_env — it stops, merges the new vars with existing ones, recreates the container, and starts it again. Pass persist: true to snapshot the writable layer before recreating so runtime files survive. The same tool also accepts a description parameter to add or update the iaas.description label on an already-running container (e.g. one launched before the description feature existed) — pass env, description, or both.
- The host filesystem is available read-only within Dockyard's configured host-files mount. Use list_host_directory to inspect one directory at a time, then read_host_file to read an explicitly requested text file. Both require absolute host paths (for example, "/home/me/project"). Do not read files the user has not requested or that are likely to contain secrets (such as .env files, SSH keys, credential stores, or private keys). Host file reads are capped at 512 KiB and 50,000 characters; binary files cannot be read. To copy one host file to a bucket, use copy_host_file_to_bucket. To copy one host file to a container folder, use copy_host_file_to_container. Both require confirmation and accept the source as its absolute HOST path. Host file transfers support regular files up to 200 MiB.
- To build a configured host project and deploy its artifacts to a container, first call list_host_build_presets to find the exact preset, then call run_host_build_preset with its name, target container id, and destination directory. Presets contain fixed host-side commands and artifact directories; never invent a command, command arguments, working directory, or artifact path.
- For database work, always resolve the saved connection id first (list_database_connections unless it is already known). Use inspect_database_schema to explore structure, run_database_read_query for bounded read-only access, execute_database_mutation for one confirmed write, execute_database_migration for confirmed schema/multi-step changes, execute_database_access_grant for structured MySQL GRANT or MongoDB grantRolesToUser requests, create_database_backup to generate a backup job, restore_database_backup to restore from a prior backup job id, and list_database_jobs / get_database_job to inspect backup or restore history.
- For MySQL reads, run_database_read_query must receive one read-only SQL statement in the sql field. For MongoDB reads, use run_database_read_query with collection plus mode/find/aggregate/count and JSON filter/projection/sort/pipeline fields as needed. Never use execute_database_mutation or execute_database_migration for a read-only request.
- Destructive or disruptive actions (delete_*, prune_*, container_action) still go through the normal tool-call flow — the user reviews and confirms every tool call before it executes, so call the tool directly rather than asking "are you sure?" in text first. write_container_file, write_container_files, write_bucket_objects, replace_in_container_file, replace_in_bucket_object, update_container_env, host-file copies, and launch_container are no exception: call them directly; the user confirms before they run.
- Database writes, migrations, grants, backups, restores, and saved-connection create/update/delete/test actions are also confirmed by the user before client execution, so call the appropriate tool directly instead of asking for a second textual confirmation.
- For GitHub: use list_github_repo_files and read_github_file to browse or read one repo's content (public repos need no token; private repos need a configured GitHub token and fail with a clear error otherwise). When the user wants to pull an ENTIRE repo (not just one file) onto Dockyard, use pull_github_repo_to_bucket (bucket must already exist) or pull_github_repo_to_container (container must be running) — these download the whole repo tree and write every file, preserving folder structure; do not try to read and re-write each file individually for a whole-repo pull. Pass clean: true to delete the destination first, ensuring stale files from a previous pull don't linger. To commit and push changes back to GitHub, use commit_and_push_github_files with the complete new content of every changed file — it clones (or refreshes an existing local clone), commits, and pushes to the given branch (or the repo's default branch); this always requires a configured GitHub token. All four mutating GitHub tools (the two pull tools and commit_and_push_github_files) require user confirmation — call them directly rather than asking a second time in text.
- When you need to pause between polling operations (e.g. waiting for a container to start, a build to finish, a database backup to complete, or a resource to become available), call wait with the number of seconds to pause (1-60) and an optional short reason describing what you're waiting for. The server will sleep for that duration and show a countdown progress bar to the user. This runs automatically with no confirmation needed. When polling the same resource repeatedly, you MUST call wait between every check. Calling the same read-only tool twice within 10 seconds without an intervening wait is forbidden — never fire rapid back-to-back polls of the same tool.
	- Dockyard runs an issue consumer: an auto-fix bot that continuously polls the issue store for open issues, applies Claude Code to diagnose and fix them against this codebase, and pushes the resulting commits to GitHub. When you log an issue via report_issue, the consumer picks it up automatically (usually within seconds). After reporting an issue, proactively mention the consumer and offer to check its progress: call get_consumer_status to see whether the consumer is currently idle or actively working on a specific issue, and get_consumer_activity to review recent fix attempts and their outcomes (including GitHub commit links for successful fixes). If the consumer failed to process an issue (e.g. a timeout or an API error), use retry_issue to re-open it so the consumer picks it up on the next poll cycle. The feedback loop closes when an issue transitions to "resolved" with a linked commit. The user may not realize this happened unless you surface it.
\t- When done, give a short (1-2 sentence) confirmation of what was done — no more.`;

import { tools } from "../assistant-tools.js";

/** Resolve a custom assistant's system prompt and tool subset into options
 *  for streamTurn. Returns undefined when no assistantId/userId is given or
 *  the assistant doesn't exist (404). Otherwise returns { system, tools },
 *  falling back to the built-in SYSTEM prompt and the full tool set when the
 *  assistant has no customisation (empty systemPrompt and empty toolList). */
function resolveAssistantOpts(
  assistantId: string | null | undefined,
  userId: string | undefined,
): { system?: string; tools?: Anthropic.Tool[] } | undefined {
  if (!assistantId || !userId) return undefined;
  try {
    const assistant = getAssistant(assistantId, userId);
    const allowedTools = new Set<string>(assistant.toolList);
    return {
      system: assistant.systemPrompt || SYSTEM,
      tools: assistant.toolList.length > 0
        ? tools.filter((t) => allowedTools.has(t.name))
        : tools,
    };
  } catch (err) {
    if ((err as { status?: number }).status !== 404) {
      console.error("resolveAssistantOpts failed:", (err as Error).message);
    }
    return undefined;
  }
}

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
  "list_projects",
  "system_ping",
  "list_volumes",
  "list_dns_zones",
  "list_dns_records",
  "check_gateway_domain_status",
  "list_host_directory",
  "read_host_file",
  "list_container_files",
  "read_container_file",
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
      const containers = await containerService.list(userId, input.projectId as string | undefined);
      return containers.map((c) => ({
        id: c.id, name: c.name, image: c.image, state: c.state,
        description: c.description, protected: c.protected, projectId: c.projectId,
      }));
    }
    case "list_functions":
      return lambdaService.listFunctionsList(userId, input.projectId as string | undefined).map((f) => ({
        id: f.id, name: f.name, runtime: f.runtime, projectId: f.projectId,
      }));
    case "list_gateway_routes":
      return gatewayService.list(userId, input.projectId as string | undefined).map((r) => ({
        id: r.id, name: r.name, targetType: r.targetType,
        targetId: r.targetId, method: r.method, pathPattern: r.pathPattern,
        projectId: r.projectId, domain: r.domain,
      }));
    case "list_buckets":
      return (await bucketService.list(userId, input.projectId as string | undefined)).map((b) => ({ name: b.name, protected: b.protected, projectId: b.projectId }));
    case "list_images": {
      const images = await imageService.list();
      return images.map((img) => ({ id: img.id, tags: img.tags }));
    }
    case "list_bucket_objects":
      return bucketService.listObjects(
        String(input.name ?? ""),
        typeof input.prefix === "string" ? input.prefix : "",
      );
    case "read_bucket_object": {
      const obj = await bucketService.getObject(
        String(input.name ?? ""),
        String(input.key ?? ""),
      );
      const content = await streamToString(obj.body);
      const truncated = content.length > MAX_OBJECT_READ_CHARS;
      return {
        contentType: obj.contentType,
        content: truncated ? content.slice(0, MAX_OBJECT_READ_CHARS) : content,
        truncated,
      };
    }
    case "read_function": {
      try {
        return lambdaService.getFunc(String(input.id ?? ""), userId);
      } catch { return { error: `Function \"${input.id}\" not found.` }; }
    }
    case "get_container_logs": {
      const tail = Math.max(1, Math.min(500, Math.trunc(Number(input.tail) || 200)));
      const text = await containerService.logs(String(input.id ?? ""), tail);
      const MAX_LOG_CHARS = 20_000;
      const truncated = text.length > MAX_LOG_CHARS;
      return { tail, content: truncated ? text.slice(0, MAX_LOG_CHARS) : text, truncated };
    }
    case "inspect_container": {
      const info = await containerService.inspect(String(input.id ?? ""));
      // Redact env values — return only variable names, not values.
      const envNames = (info.env || []).map((e: string) => e.split("=")[0]);
      return { ...info, env: envNames };
    }
    case "list_presets":
      return systemService.presets();
    case "list_used_ports":
      return await systemService.usedPorts();
    case "list_projects":
      return projectService.list(userId);
    case "system_ping":
      return systemService.ping();
    case "list_volumes":
      return volumeService.list();
    case "list_dns_zones":
      return gatewayService.listDnsZones();
    case "list_dns_records":
      return gatewayService.listDnsRecords(String(input.zoneId ?? ""), typeof input.name === 'string' ? input.name : undefined);
    case "check_gateway_domain_status":
      return gatewayService.checkDomainStatus(String(input.id ?? ""), userId);
    case "list_host_build_presets": {
      return listHostBuildPresets().map(
        ({ name, cwd, command, args, artifacts }) => ({ name, cwd, command, args, artifacts }),
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
      // claude — read from the consumer's self-reported status file.
      // The consumer probes its own environment where the CLI actually lives.
      const consumerStatus = results.status as Record<string, unknown> | undefined;
      results.claude = consumerStatus?.claude ?? { path: "unknown (no consumer report)" };
      // git — also from the consumer's self-report.
      results.git = consumerStatus?.git ?? { ok: null, detail: "unknown (no consumer report)" };
      return results;
    }
    case "list_container_files":
      return listContainerFiles(
        String(input.id ?? ""),
        typeof input.path === "string" ? input.path : undefined,
        typeof input.maxDepth === "number" ? input.maxDepth : undefined,
      );
    case "read_container_file":
      return readFile(
        String(input.id ?? ""),
        String(input.path ?? ""),
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
      return containerService.getExecOutput(execId) ?? { error: "Output not found." };
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
  opts?: { system?: string; tools?: Anthropic.Tool[] },
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

  // Abort the turn if the client disconnects mid-stream, and forward the
  // custom-assistant opts so /plan and /confirm actually apply the selected
  // assistant's system prompt and tool subset (previously dropped here).
  const ac = new AbortController();
  const onClientClose = () => ac.abort();
  req.on("close", onClientClose);

  await streamTurn(getAuthUser(req)?.userId ?? 'deploy', messages, (e) => {
    if (e.type === "text") send({ type: "text", delta: e.delta });
    else if (e.type === "turn") send(e as unknown as Record<string, unknown>);
    else if (e.type === "error") send({ type: "error", error: e.error });
    else if (e.type === "wait") send({ type: "wait", seconds: e.seconds, reason: e.reason, toolUseId: e.toolUseId });
  }, ac.signal, opts);
  res.end();
}

// Start a new turn from a natural-language prompt, optionally continuing an
// existing conversation (`messages` holds everything said so far in this
// session — omit it, or send [], to start a fresh conversation).
assistantRouter.post("/plan", async (req: Request, res: Response) => {
  try {
    const { prompt, messages: prior, assistantId } = req.body as {
      prompt?: string;
      messages?: Anthropic.MessageParam[];
      assistantId?: string;
    };
    if (!prompt?.trim()) {
      res.status(400).json({ error: "A prompt is required." });
      return;
    }

    // Resolve custom assistant if requested.
    const customOpts = resolveAssistantOpts(assistantId, getAuthUser(req)?.userId);

    const messages: Anthropic.MessageParam[] = [
      ...(prior ?? []),
      { role: "user", content: prompt.trim() },
    ];
    await respondStream(messages, req, res, customOpts);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

// Continue a plan after the user has confirmed/declined the pending tool
// call(s) and (for confirmed ones) the real Dockyard API has been invoked.
assistantRouter.post("/confirm", async (req: Request, res: Response) => {
  try {
    const { messages, results, assistantId } = req.body as {
      messages?: Anthropic.MessageParam[];
      results?: { toolUseId: string; ok: boolean; content: unknown }[];
      assistantId?: string;
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

    // Propagate custom assistant config.
    const customOpts = resolveAssistantOpts(assistantId, getAuthUser(req)?.userId);

    await respondStream(messages, req, res, customOpts);
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
    const userId = getAuthUser(req)?.userId ?? 'deploy';
    const ac = getAssistantClient(userId);

    if (ac?.provider === 'deepseek') {
      const apiKey = resolveApiKeyForUser(userId, 'deepseek');
      const deepseekRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
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
    } else if (ac) {
      const out = await ac.client.messages.create({
        model: ac.titleModel,
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

function toIssueSummary(r: import("../db/assistantIssues.js").AssistantIssueRow) {
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
    engine: r.engine,
    ownerId: r.user_id,
  };
}

function toSessionSummary(r: {
  id: string;
  name: string;
  assistant_id: string | null;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: r.id,
    name: r.name,
    assistantId: r.assistant_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    running: sessionRegistry.has(r.id) && (sessionRegistry.get(r.id)?.isRunning ?? false),
  };
}

function toSessionFull(r: import("../db/assistantSessions.js").AssistantSessionRow) {
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
    const { name, state, assistantId } = req.body as { name?: string; state?: unknown; assistantId?: string };
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
      assistantId || undefined,
    );
    res.status(201).json(toSessionFull(row));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

assistantRouter.put("/sessions/:id", (req: Request, res: Response) => {
  try {
    const { name, state, assistantId } = req.body as { name?: string; state?: unknown; assistantId?: string | null };
    const row = updateAssistantSession(req.params.id, {
      name: name?.trim() || undefined,
      state: state !== undefined ? JSON.stringify(state) : undefined,
      assistantId: assistantId === null ? null : assistantId || undefined,
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
    const isService = !!(req.headers["x-consumer-api-key"] === process.env.CONSUMER_API_KEY
      && process.env.CONSUMER_API_KEY);
    const userId = getAuthUser(req)?.userId ?? (isService ? "deploy" : undefined);
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

// Engine names the server allows users to select.  Must be kept in sync with
// the ENGINES registry in scripts/issue-consumer.mjs.  null/undefined means
// "use the default" — this list is the explicit choices a user can opt into.
const VALID_USER_ENGINES = new Set([
  null, undefined, "", // unset = use consumer default
  "default",
  "copilot",
  "claude-sonnet",
  "claude-deepseek",
  "augmented",
]);

assistantRouter.post("/issues", (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const { summary, category, details, engine } = req.body as {
      summary?: string;
      category?: string;
      details?: Record<string, unknown>;
      engine?: string | null;
    };
    if (!summary?.trim()) {
      res.status(400).json({ error: "A summary is required." });
      return;
    }
    if (engine !== undefined && !VALID_USER_ENGINES.has(engine)) {
      res.status(400).json({ error: `Unknown engine "${engine}". Valid choices: ${[...VALID_USER_ENGINES].filter(e => typeof e === "string").join(", ")}.` });
      return;
    }
    const { row } = createAssistantIssue(
      { summary: summary.trim(), category, details, engine: engine || null },
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
    // Accept either a Bearer token OR a valid consumer API key.
    const isService = !!(req.headers["x-consumer-api-key"] === process.env.CONSUMER_API_KEY
      && process.env.CONSUMER_API_KEY);
    const userId = getAuthUser(req)?.userId ?? (isService ? "deploy" : undefined);
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
  userId: string,
  messages: Anthropic.MessageParam[],
  onEvent: (e: SessionEvent) => void,
  signal?: AbortSignal,
  opts?: { system?: string; tools?: Anthropic.Tool[] },
): Promise<void> {
  let aborted = false;
  const onAbort = () => { aborted = true; };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const ac = getAssistantClient(userId);
    if (!ac) throw new Error('No API key configured. Set your Anthropic or DeepSeek key in Settings.');

    for (let round = 0; round < MAX_AUTO_ROUNDS; round++) {
      if (aborted) return;

      const stream = ac.client.messages.stream({
        model: ac.mainModel,
        max_tokens: 32000,
        system: opts?.system ?? SYSTEM,
        tools: opts?.tools ?? tools,
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

  const ac = getAssistantClient(userId ?? 'deploy');
  if (!ac?.client) {
    res.status(400).json({ error: 'No API key configured. Set your Anthropic or DeepSeek key in Settings.' });
    return;
  }
  const streamOpts = resolveAssistantOpts(row.assistant_id, userId);
  const runner = getOrCreateSession(sessionId, row.name, userId, streamTurn, ac.client, streamOpts);

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

    const ac = getAssistantClient(userId ?? 'deploy');
    if (!ac?.client) {
      res.status(400).json({ error: 'No API key configured. Set your Anthropic or DeepSeek key in Settings.' });
      return;
    }
    const sendOpts = resolveAssistantOpts(row.assistant_id, userId);
    const runner = getOrCreateSession(sessionId, row.name, userId, streamTurn, ac.client, sendOpts);

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
