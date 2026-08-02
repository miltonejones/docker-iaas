import type Anthropic from "@anthropic-ai/sdk";
import { buildAssistantTools } from "./tool-schemas.js";
import {
  DATABASE_ASSISTANT_TOOLS,
} from "./databaseAssistantTools.js";
import {
  GITHUB_ASSISTANT_TOOLS,
} from "./githubAssistantTools.js";

const ASSISTANT_DESCRIPTIONS: Record<string, string> = {
  create_lambda_function:
    "Create a new Lambda function with a name, runtime (node, python, sh), and source code. Optionally specify packages to install (space-separated list), an entry point filename, additional files (an array of {path, content}), a description, and a projectId. The user confirms before the function is created.",
  create_gateway_route:
    "Create a gateway route to expose a bucket, container, or Lambda function via a public URL. Requires a name (URL segment), targetType, and targetId. For containers, targetPort is also required. Optional: method filter, pathPattern, projectId, displayName, domain (assigns a custom domain at creation time). The user confirms before the route is created.",
  update_lambda_function:
    "Update a saved Lambda function. Pass the function id and any fields you want to change (name, runtime, code, packages, entryPoint, files, description, projectId). Omit fields to keep their current value. The user confirms before the update.",
  delete_lambda_function:
    "Delete a saved Lambda function by id. The user confirms before deletion.",
  delete_gateway_route:
    "Delete a gateway route by id. The user confirms before deletion.",
  update_gateway_route:
    "Update a gateway route's configuration. Pass the route id and any fields to change: displayName, targetPort, method, pathPattern, or domain (set to null to clear). Omit fields to keep their current value. The user confirms before the update.",
  check_gateway_domain_status:
    "Check the verification status of a custom domain on a gateway route (read-only, runs automatically).",
  set_gateway_domain:
    "Set a custom domain on a gateway route. Pass the route id and domain name. The user confirms before the domain is assigned.",
  enable_gateway_domain:
    "Provision TLS certificate and configure DNS for a gateway route that has a domain assigned. The user confirms before enabling.",
  remove_gateway_domain:
    "Remove a custom domain from a gateway route, tearing down TLS and DNS config. The user confirms before removal.",
  list_dns_zones:
    "List Route 53 hosted zones (read-only, runs automatically).",
  list_dns_records:
    "List DNS records in a Route 53 hosted zone (read-only, runs automatically).",
  create_dns_record:
    "Create a DNS CNAME record in a Route 53 zone. Pass zoneId and name. The user confirms before creation.",
  delete_dns_record:
    "Delete a DNS record from a Route 53 zone. Pass zoneId and name. The user confirms before deletion.",
  launch_container:
    'Launch a new Docker container, either from a named preset or a raw image. Pass command to override the image\'s default CMD — useful for keeping build images alive with ["sleep","infinity"] when they\'d otherwise exit immediately. Use projectId to assign the container to a project (look up IDs with list_projects). Set volumes for persistent data mounts (e.g. ["mydata:/app/data"]). Set autoStart to false to create but not start.',
  container_action:
    "Start, stop, or restart a running container. Pass the container id and the action to take.",
  write_container_file:
    "Write a text file into a running container at the given absolute path. Useful for deploying static site files, config files, or scripts directly into a running container.",
  execute_container_command:
    "Run an arbitrary command inside a running assistant-managed container. Pass the command as an array of separate string arguments — never a shell string. Commands must complete within the timeout or they'll be terminated. Verify the exit code before trusting the output. When making bulk changes across a large file set, prefer write_container_files over writing one at a time.",
  get_container_exec_output:
    "Retrieve the output of a previously started background exec by its execId.",
  copy_host_file_to_container:
    "Copy a large file from the host filesystem directly into a running container. Use when the file is too large for write_container_file. Requires absolute host sourcePath, container id, and absolute destination path.",
  delete_container:
    "Remove a Docker container by id — this deletes its writable layer (any files not in a named volume or bind mount). The user confirms before deletion.",
  delete_image:
    "Delete a Docker image by id. The user confirms before deletion.",
  prune_images:
    "Prune dangling Docker images and stopped containers to reclaim disk space. The user confirms before pruning.",
  create_bucket:
    "Create a new storage bucket. Requires a name. Pass protected: true to prevent accidental deletion, and projectId to assign it to a project immediately. The user confirms before creation.",
  delete_bucket:
    "Delete a storage bucket. The bucket must be empty. The user confirms before deletion.",
  delete_bucket_object:
    "Delete a specific object (file) from a bucket by key. The user confirms before deletion.",
  update_bucket:
    "Toggle the protected flag on a bucket and/or assign it to a project. Pass the bucket name, the new protected value (true/false), and optionally projectId. The user confirms before the update.",
  write_bucket_object:
    "Write a text object (file) to a bucket at the given key. If an object already exists at that key, it is overwritten.",
  copy_host_file_to_bucket:
    "Copy a large file from the host filesystem directly into a bucket. Requires absolute host sourcePath, bucket name, and object key.",
  list_host_directory:
    "List the contents of a directory on the host filesystem. Returns entry names, types (directory/file/symlink), sizes, and modification times.",
  read_host_file:
    "Read the contents of a text file on the host filesystem. The file must be a regular file under the configured host disk path.",
  run_host_build_preset:
    "Run a pre-configured host build preset and deploy the resulting artifacts directly into a running container. Requires the preset name, container id, and absolute destination path. The user confirms before the build runs.",
  prune_build_cache:
    "Prune the Docker build cache to reclaim disk space. The user confirms before pruning.",
  list_containers:
    "List all containers (id, name, image, state, description, protected) — use this to resolve a container the user referred to by name to its id. Optionally filter by project.",
  list_functions:
    "List all saved Lambda functions (id, name, runtime) — use this to resolve a function's name to its id. Optionally filter by project.",
  list_gateway_routes:
    "List all gateway routes (id, name, targetType, targetId, method, pathPattern) — use this to resolve a route's name to its id. Optionally filter by project.",
  list_buckets:
    "List all storage buckets (name, protected flag). Optionally filter by project.",
  list_images:
    "List all Docker images (id, tags) — use this to resolve an image's tag to its id.",
  list_bucket_objects:
    "List the files (and folder-like prefixes) inside a bucket, optionally under a prefix. Use this before modifying an existing bucket-hosted site to see what files already exist.",
  read_bucket_object:
    "Read a text file's content from a bucket. Use this before editing an existing file with write_bucket_object, so the edit is based on the real current content rather than a guess.",
  read_function:
    "Read a Lambda function's full details including its source code, runtime, packages, and entry point. Use this when the user asks what a function does or wants to see its code — list_functions only returns id/name/runtime, not the code itself.",
  get_container_logs:
    "Get the stdout/stderr logs from a container — the primary debugging tool. Pass the container id and an optional tail count (default 200). Always check logs before declaring a container broken or stuck.",
  inspect_container:
    "Get comprehensive config details for a container: image, ports, volumes, environment variable names (values redacted for security), labels, restart policy, state.",
  list_presets:
    "List all pre-configured container launch presets (e.g. ubuntu, redis, postgres, nginx) with their image, default ports, volumes, and description.",
  list_used_ports:
    "List the host ports currently published by running containers (read-only, runs automatically with no confirmation). Use this before launching a container with a specific host port to avoid a conflict, or when the user asks what ports are in use.",
  list_host_build_presets:
    "List administrator-configured host build presets. Each preset has a name, fixed command/arguments, host working directory, and artifact directory. Read-only, runs automatically with no confirmation.",
  run_function:
    "Run a saved Lambda function by id and return its stdout, status code, and duration. Use this when the user asks to test or run a function. An optional JSON `payload` is provided to the function as the DOCKYARD_REQUEST environment variable (the gateway contract); omit it for functions that take no request. The function runs with its saved environment variables, the same as the editor Run button and gateway invocations. The user confirms before it runs.",
  update_container_env:
    "Update environment variables, the description label, and/or the protected flag on a container. Docker requires recreating a container to change env or labels, so your files are safe (named volumes survive). Pass the container id and the new env array, new description, and/or new protected boolean. The user confirms before the update.",
  replace_in_container_file:
    "Search-and-replace literal text in a file inside a running container. Reads the file, applies the replacement, and writes it back.",
  read_container_file:
    "Read a text file from a running container and return its content (capped at 256 KiB). Use this to inspect config files, build output, logs written to disk, or any other text file inside a container without running a shell command.",
  copy_to_container:
    "Copy a file or directory into a container from another container or from a bucket. For container-to-container copies: sourceType='container', sourceContainerId, sourcePath, dest container id, destPath. For bucket-to-container: sourceType='bucket', sourceBucket, sourceKey, dest container id, destPath. Uses tar streaming under the hood so it handles binaries and large files efficiently. When copying a directory, the contents land inside destPath. The user confirms before the copy executes.",
  replace_in_bucket_object:
    "Search-and-replace literal text in an object stored in a bucket, overwriting it in place. Use this for quick targeted edits to a hosted site file.",
  list_container_files:
    "Recursively list the files and directories inside a container path, like find(1). Returns up to 200 entries with type, size, and modification time. Use this before writing files to verify paths exist, or to audit deployed content.",
  probe_container_endpoint:
    "Send an HTTP request to a port inside a running container, from the same Docker network. Returns the status code, response headers, and up to 4 KiB of body. Use this after deploying a web app to make sure it's actually responding.",
  write_container_files:
    "Write multiple files into a running container in a single call. Accepts an array of {path, content} objects. Use this for bulk site deployment — much faster than calling write_container_file once per file.",
  write_bucket_objects:
    "Write multiple objects into a bucket in a single call. Accepts an array of {key, content, contentType?} objects. Use this for bulk site deployment — much faster than calling write_bucket_object once per file.",
  list_projects:
    "List all projects with their resource summaries (container count, function count, route count, bucket count). Use this whenever the user mentions a project by name — it maps names to IDs.",
  create_project:
    "Create a new project to organize resources (containers, functions, buckets, routes) into a named group. Requires a name; optional description. The user must confirm before creation.",
  update_project:
    "Update a project's name or description. Requires the project id. The user must confirm before updating.",
  delete_project:
    "Delete a project. Resources linked to the project are NOT deleted — they just have their project association cleared. The user must confirm before deletion.",
  get_project_manifest:
    "Get the captured manifest for a project — the JSON snapshot of resources (containers, routes, functions, buckets, databases) taken the last time capture_project_manifest ran. Resources listed in ANY project's manifest cannot be deleted, and routes in one cannot have their target port changed, by non-admin users — check this before deleting or reconfiguring a resource that might belong to a project, and mention the protection to the user if it applies. Read-only, runs automatically. Returns an error if the project has no captured manifest yet.",
  get_manifest_drift:
    "Compare a project's captured manifest against live resource state. Returns { synced, missing, changed, orphaned } — missing entries no longer exist, changed entries have diverged (e.g. env vars or target changed since capture), orphaned entries are linked to the project but weren't captured. Use this to tell the user when a project's manifest is stale and suggest re-running capture_project_manifest. Read-only, runs automatically. Returns an error if the project has no captured manifest yet.",
  capture_project_manifest:
    "Snapshot every resource currently linked to a project (containers, routes, functions, buckets, databases) into that project's manifest. Resources in the manifest become protected: non-admin users can no longer delete them or change a route's target port until the resource is unlinked from the project. Re-running this replaces the previous snapshot. The user confirms before capture runs.",
  system_ping: "Ping the Docker daemon to verify it's reachable.",
  list_volumes: "List Docker volumes with driver, mountpoint, size, and reference count.",
  list_database_connections: "List saved database connections (MySQL or MongoDB).",
  get_database_connection: "Get details for a saved database connection.",
  get_database_operations_overview: "Get overview of database engine capabilities.",
  inspect_database_schema: "Inspect the schema of a database connection.",
  run_database_read_query: "Run a read-only SQL query or MongoDB find/aggregate.",
  test_database_connection: "Test a saved database connection.",
  create_database_connection: "Create a new database connection.",
  update_database_connection: "Update a database connection.",
  delete_database_connection: "Delete a database connection.",
  execute_database_mutation: "Execute a mutating SQL statement or MongoDB write operation. Requires confirmed: true.",
  execute_database_migration: "Execute a DDL migration (CREATE/ALTER/DROP). Requires confirmed: true.",
  execute_database_access_grant: "Grant or revoke database privileges. Requires confirmed: true.",
  create_database_backup: "Create a backup of a database. Requires confirmed: true.",
  restore_database_backup: "Restore a database from a backup. Requires confirmed: true.",
  list_database_jobs: "List database backup/restore jobs.",
  get_database_job: "Get details for a database job.",
  list_github_repo_files: "List files in a GitHub repository.",
  read_github_file: "Read a file from a GitHub repository.",
  pull_github_repo_to_bucket:
    "Pull an entire GitHub repository into a bucket. Pass clean: true to delete destination first. Requires confirmation.",
  pull_github_repo_to_container:
    "Pull an entire GitHub repository into a container. Pass clean: true to delete destination first. Requires confirmation.",
  commit_and_push_github_files:
    "Commit and push files to a GitHub repository. Requires repo, branch, commit message, and array of {path, content} files. Requires confirmation.",
};

const ASSISTANT_ONLY_TOOLS: Array<{
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}> = [
  {
    name: "wait",
    description:
      "Wait a fixed number of seconds before the next action. Use this when you need a pause between two operations, such as waiting for a container to fully start before probing its endpoint, or waiting for a newly created bucket to propagate before writing objects.",
    input_schema: {
      type: "object",
      properties: {
        seconds: { type: "number", description: "Number of seconds to wait (0.5-60)" },
      },
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
          description: "Structured details about the issue (messages, context, error data)",
        },
      },
      required: ["summary", "category"],
    },
  },
  {
    name: "list_issues",
    description:
      "List recently reported issues, newest first. Pass status to filter (open, in_progress, fixed, failed, closed). Read-only, runs automatically with no confirmation.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max issues to return (default 20, max 50)" },
        status: {
          type: "string",
          description: "Filter by status (open, in_progress, fixed, failed, closed)",
        },
      },
    },
  },
  {
    name: "get_issue",
    description:
      "Get the full details of a specific issue by id (e.g. iss-abc123). Read-only, runs automatically.",
    input_schema: {
      type: "object",
      properties: {
        issueId: { type: "string", description: "Issue id (e.g. iss-abc123)" },
      },
      required: ["issueId"],
    },
  },
  {
    name: "update_issue",
    description:
      "Update the status, resolution, or resolved-by field of an issue. The user confirms before the update.",
    input_schema: {
      type: "object",
      properties: {
        issueId: { type: "string", description: "Issue id" },
        status: {
          type: "string",
          enum: ["open", "in_progress", "fixed", "failed", "closed"],
          description: "New status",
        },
        resolution: { type: "string", description: "Resolution description (e.g. fix summary)" },
        resolvedBy: { type: "string", description: "Who or what resolved the issue" },
      },
      required: ["issueId"],
    },
  },
  {
    name: "delete_issue",
    description: "Delete an issue by id. The user confirms before deletion.",
    input_schema: {
      type: "object",
      properties: {
        issueId: { type: "string", description: "Issue id" },
      },
      required: ["issueId"],
    },
  },
  {
    name: "clear_issues",
    description: "Delete ALL issues. The user confirms before clearing.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "retry_issue",
    description:
      "Re-open an issue so the consumer picks it up again. Use when the consumer failed to process an issue and you want to retry.",
    input_schema: {
      type: "object",
      properties: {
        issueId: { type: "string", description: "Issue id to retry" },
      },
      required: ["issueId"],
    },
  },
  {
    name: "get_consumer_status",
    description:
      "Get the current state of the automated issue consumer (running, idle, sleeping, error). Read-only, runs automatically.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_consumer_activity",
    description:
      "List the most recent issue consumer activity logs. Read-only, runs automatically.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max log entries (default 10, max 20)" },
      },
    },
  },
  {
    name: "check_consumer_health",
    description:
      "Run a full health check on the consumer: status file, DB access, API reachability, Claude availability, git config. Returns pass/fail for each.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "replace_lambda_function_files",
    description:
      "Replace the set of extra files (beyond the entry file) attached to a saved Lambda function. Pass the function id and the complete new array of {path, content} objects for the extra files. Files not in the array are deleted; matching paths are updated. The entry-point file (code field) is NOT affected by this — use update_lambda_function to change it. The user confirms before the replacement.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Function id, e.g. fn-abc123" },
        entryPoint: { type: "string", description: "Entry point filename (e.g. \"index.js\")" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path" },
              content: { type: "string", description: "File content" },
            },
            required: ["path", "content"],
          },
          description: "Complete new set of extra files",
        },
      },
      required: ["id", "files"],
    },
  },
];

// Tools provided by separate modules — excluded from buildAssistantTools to avoid duplicates.
const SEPARATE_MODULE_NAMES = new Set([
  ...DATABASE_ASSISTANT_TOOLS.map((t: { name: string }) => t.name),
  ...GITHUB_ASSISTANT_TOOLS.map((t: { name: string }) => t.name),
]);

export const tools: Anthropic.Tool[] = [
  ...buildAssistantTools(ASSISTANT_DESCRIPTIONS, ASSISTANT_ONLY_TOOLS, SEPARATE_MODULE_NAMES),
  ...DATABASE_ASSISTANT_TOOLS,
  ...GITHUB_ASSISTANT_TOOLS,
];
