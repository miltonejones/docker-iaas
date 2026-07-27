// Shared tool schema definitions for the assistant and MCP server.
// Each entry has a stable `name` and canonical `properties`.
// Descriptions are minimal here — each consumer layers its own rich descriptions.
// This ensures the assistant and MCP server never drift out of sync.

interface ToolSchema {
  name: string;
  description: string;
  properties: Record<string, {
    type: string;
    description: string;
    items?: unknown;
    enum?: string[];
    required?: string[];
  }>;
  required?: string[];
}

// ── Containers (14) ─────────────────────────────────────────────

const CONTAINER_TOOLS: ToolSchema[] = [
  {
    name: 'list_containers',
    description: 'List all Docker containers.',
    properties: {
      projectId: { type: 'string', description: 'Filter containers by project ID' },
    },
  },
  {
    name: 'launch_container',
    description: 'Launch a new Docker container from a preset or image.',
    properties: {
      presetId: { type: 'string', description: 'Preset ID to use' },
      image: { type: 'string', description: 'Docker image to use' },
      name: { type: 'string', description: 'Container name' },
      description: { type: 'string', description: 'Human-readable description' },
      protected: { type: 'boolean', description: 'Prevent accidental deletion/stop' },
      projectId: { type: 'string', description: 'Project to associate this container with' },
      command: { type: 'array', items: { type: 'string' }, description: 'Command to run' },
      ports: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            container: { type: 'string', description: 'Container port (e.g. "6379" or "6379/tcp")' },
            host: { type: 'number', description: 'Host port' },
          },
          required: ['container', 'host'],
        },
        description: 'Port mappings',
      },
      env: {
        type: 'array',
        items: {
          type: 'object',
          properties: { key: { type: 'string', description: 'Variable name' }, value: { type: 'string', description: 'Variable value' } },
          required: ['key', 'value'],
        },
        description: 'Environment variables',
      },
      volumes: { type: 'array', items: { type: 'string' }, description: 'Volume mounts (e.g. "mydata:/app/data")' },
      autoStart: { type: 'boolean', description: 'Start the container after creation (default: true)' },
    },
  },
  {
    name: 'inspect_container',
    description: 'Get full details about a Docker container.',
    properties: { id: { type: 'string', description: 'Container ID' } },
    required: ['id'],
  },
  {
    name: 'container_action',
    description: 'Start, stop, or restart a container.',
    properties: {
      id: { type: 'string', description: 'Container ID' },
      action: { type: 'string', enum: ['start', 'stop', 'restart'], description: 'Action to perform' },
    },
    required: ['id', 'action'],
  },
  {
    name: 'delete_container',
    description: 'Remove a Docker container.',
    properties: {
      id: { type: 'string', description: 'Container ID' },
      force: { type: 'boolean', description: 'Force removal' },
    },
    required: ['id'],
  },
  {
    name: 'get_container_logs',
    description: 'Get logs from a Docker container.',
    properties: {
      id: { type: 'string', description: 'Container ID' },
      tail: { type: 'number', description: 'Number of lines from the end (default: 200)' },
    },
    required: ['id'],
  },
  {
    name: 'update_container_env',
    description: 'Update environment variables, description, or protected flag on a container.',
    properties: {
      id: { type: 'string', description: 'Container ID' },
      env: {
        type: 'array',
        items: {
          type: 'object',
          properties: { key: { type: 'string', description: 'Variable name' }, value: { type: 'string', description: 'Variable value' } },
          required: ['key', 'value'],
        },
        description: 'Environment variables to set',
      },
      persist: { type: 'boolean', description: 'Snapshot filesystem before recreating' },
      description: { type: 'string', description: 'New description text' },
      protected: { type: 'boolean', description: 'Set protected flag' },
      projectId: { type: 'string', description: 'Assign to project (null to clear)' },
    },
    required: ['id'],
  },
  {
    name: 'execute_container_command',
    description: 'Execute a command in a running container.',
    properties: {
      id: { type: 'string', description: 'Container ID' },
      command: { type: 'array', items: { type: 'string' }, description: 'Command and arguments' },
      workingDir: { type: 'string', description: 'Working directory inside the container' },
      background: { type: 'boolean', description: 'Run in background and return execId' },
      timeoutSeconds: { type: 'number', description: 'Timeout in seconds (1-600)' },
    },
    required: ['id', 'command'],
  },
  {
    name: 'get_container_exec_output',
    description: 'Get output from a background exec.',
    properties: { execId: { type: 'string', description: 'Exec ID from execute_container_command' } },
    required: ['execId'],
  },
  {
    name: 'write_container_file',
    description: 'Write a file to a running container.',
    properties: {
      id: { type: 'string', description: 'Container ID' },
      path: { type: 'string', description: 'Absolute path inside the container' },
      content: { type: 'string', description: 'File content' },
    },
    required: ['id', 'path'],
  },
  {
    name: 'write_container_files',
    description: 'Write multiple files to a running container in one call.',
    properties: {
      id: { type: 'string', description: 'Container ID' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'File content' } },
          required: ['path', 'content'],
        },
        description: 'Array of { path, content }',
      },
    },
    required: ['id', 'files'],
  },
  {
    name: 'replace_in_container_file',
    description: 'Search and replace text in a container file.',
    properties: {
      id: { type: 'string', description: 'Container ID' },
      path: { type: 'string', description: 'Absolute path inside the container' },
      search: { type: 'string', description: 'String to search for' },
      replace: { type: 'string', description: 'Replacement string' },
    },
    required: ['id', 'path', 'search'],
  },
  {
    name: 'list_container_files',
    description: 'List files in a container directory.',
    properties: {
      id: { type: 'string', description: 'Container ID' },
      path: { type: 'string', description: 'Directory path (default: /)' },
      maxDepth: { type: 'number', description: 'Max recursion depth (default: 4)' },
    },
    required: ['id'],
  },
  {
    name: 'probe_container_endpoint',
    description: 'Probe an HTTP endpoint inside a container.',
    properties: {
      id: { type: 'string', description: 'Container ID' },
      port: { type: 'number', description: 'Port to probe' },
      path: { type: 'string', description: 'URL path (default: /)' },
      method: { type: 'string', description: 'HTTP method (default: GET)' },
    },
    required: ['id', 'port'],
  },
];

// ── Buckets (10) ────────────────────────────────────────────────

const BUCKET_TOOLS: ToolSchema[] = [
  {
    name: 'list_buckets',
    description: 'List all storage buckets.',
    properties: { projectId: { type: 'string', description: 'Filter by project ID' } },
  },
  {
    name: 'create_bucket',
    description: 'Create a new storage bucket.',
    properties: {
      name: { type: 'string', description: 'Bucket name' },
      protected: { type: 'boolean', description: 'Prevent accidental deletion' },
      projectId: { type: 'string', description: 'Project ID to assign this bucket to' },
    },
    required: ['name'],
  },
  {
    name: 'delete_bucket',
    description: 'Delete a storage bucket.',
    properties: { name: { type: 'string', description: 'Bucket name' } },
    required: ['name'],
  },
  {
    name: 'update_bucket',
    description: 'Toggle protected status on a bucket.',
    properties: {
      name: { type: 'string', description: 'Bucket name' },
      protected: { type: 'boolean', description: 'Protected flag' },
      projectId: { type: 'string', description: 'Project ID to assign (omit or pass null to leave unchanged)' },
    },
    required: ['name', 'protected'],
  },
  {
    name: 'list_bucket_objects',
    description: 'List objects in a bucket.',
    properties: {
      name: { type: 'string', description: 'Bucket name' },
      prefix: { type: 'string', description: 'Prefix filter' },
    },
    required: ['name'],
  },
  {
    name: 'read_bucket_object',
    description: 'Read a bucket object as text.',
    properties: {
      name: { type: 'string', description: 'Bucket name' },
      key: { type: 'string', description: 'Object key' },
    },
    required: ['name', 'key'],
  },
  {
    name: 'write_bucket_object',
    description: 'Write a text object to a bucket.',
    properties: {
      name: { type: 'string', description: 'Bucket name' },
      key: { type: 'string', description: 'Object key' },
      content: { type: 'string', description: 'Object content' },
      contentType: { type: 'string', description: 'Content type' },
    },
    required: ['name', 'key', 'content'],
  },
  {
    name: 'write_bucket_objects',
    description: 'Write multiple objects to a bucket in one call.',
    properties: {
      name: { type: 'string', description: 'Bucket name' },
      objects: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Object key' },
            content: { type: 'string', description: 'Object content' },
            contentType: { type: 'string', description: 'Content type' },
          },
          required: ['key', 'content'],
        },
        description: 'Array of { key, content, contentType? }',
      },
    },
    required: ['name', 'objects'],
  },
  {
    name: 'delete_bucket_object',
    description: 'Delete an object from a bucket.',
    properties: {
      name: { type: 'string', description: 'Bucket name' },
      key: { type: 'string', description: 'Object key' },
    },
    required: ['name', 'key'],
  },
  {
    name: 'replace_in_bucket_object',
    description: 'Search and replace text in a bucket object.',
    properties: {
      name: { type: 'string', description: 'Bucket name' },
      key: { type: 'string', description: 'Object key' },
      search: { type: 'string', description: 'String to find' },
      replace: { type: 'string', description: 'Replacement string' },
    },
    required: ['name', 'key', 'search'],
  },
];

// ── Gateway (6) ─────────────────────────────────────────────────

const GATEWAY_TOOLS: ToolSchema[] = [
  {
    name: 'list_gateway_routes',
    description: 'List all gateway routes.',
    properties: { projectId: { type: 'string', description: 'Filter by project ID' } },
  },
  {
    name: 'create_gateway_route',
    description: 'Create a new gateway route.',
    properties: {
      name: { type: 'string', description: 'Route name (URL segment)' },
      displayName: { type: 'string', description: 'Display name' },
      targetType: { type: 'string', enum: ['bucket', 'container', 'lambda'], description: 'Target type' },
      targetId: { type: 'string', description: 'Target resource ID' },
      targetPort: { type: 'number', description: 'Target port (required for containers)' },
      method: { type: 'string', description: 'HTTP method filter' },
      pathPattern: { type: 'string', description: 'URL path pattern' },
      projectId: { type: 'string', description: 'Project ID' },
    },
    required: ['name', 'targetType', 'targetId'],
  },
  {
    name: 'update_gateway_route',
    description: 'Update a gateway route.',
    properties: {
      id: { type: 'string', description: 'Route ID' },
      displayName: { type: 'string', description: 'New display name' },
    },
    required: ['id'],
  },
  {
    name: 'delete_gateway_route',
    description: 'Delete a gateway route.',
    properties: { id: { type: 'string', description: 'Route ID' } },
    required: ['id'],
  },
  {
    name: 'check_gateway_domain_status',
    description: 'Check verification status of a custom domain on a gateway route. Read-only.',
    properties: { id: { type: 'string', description: 'Gateway route ID' } },
    required: ['id'],
  },
  {
    name: 'set_gateway_domain',
    description: 'Set a custom domain on a gateway route.',
    properties: {
      id: { type: 'string', description: 'Gateway route ID' },
      domain: { type: 'string', description: 'Domain name to assign' },
    },
    required: ['id', 'domain'],
  },
  {
    name: 'enable_gateway_domain',
    description: 'Provision TLS certificate and configure DNS for a gateway route.',
    properties: { id: { type: 'string', description: 'Gateway route ID' } },
    required: ['id'],
  },
  {
    name: 'remove_gateway_domain',
    description: 'Remove a custom domain from a gateway route.',
    properties: { id: { type: 'string', description: 'Gateway route ID' } },
    required: ['id'],
  },
  {
    name: 'list_dns_zones',
    description: 'List Route 53 hosted zones.',
    properties: {},
  },
  {
    name: 'list_dns_records',
    description: 'List DNS records in a Route 53 hosted zone.',
    properties: {
      zoneId: { type: 'string', description: 'Route 53 hosted zone ID' },
      name: { type: 'string', description: 'Optional record name filter' },
    },
    required: ['zoneId'],
  },
  {
    name: 'create_dns_record',
    description: 'Create a DNS CNAME record in a Route 53 hosted zone.',
    properties: {
      zoneId: { type: 'string', description: 'Route 53 hosted zone ID' },
      name: { type: 'string', description: 'Record name (e.g. \"www.example.com\")' },
    },
    required: ['zoneId', 'name'],
  },
  {
    name: 'delete_dns_record',
    description: 'Delete a DNS record from a Route 53 hosted zone.',
    properties: {
      zoneId: { type: 'string', description: 'Route 53 hosted zone ID' },
      name: { type: 'string', description: 'Record name to delete' },
    },
    required: ['zoneId', 'name'],
  },
];

// ── Lambda (6) ──────────────────────────────────────────────────

const LAMBDA_TOOLS: ToolSchema[] = [
  {
    name: 'list_functions',
    description: 'List all saved Lambda functions.',
    properties: { projectId: { type: 'string', description: 'Filter by project ID' } },
  },
  {
    name: 'read_function',
    description: 'Get a saved Lambda function by ID.',
    properties: { id: { type: 'string', description: 'Function ID' } },
    required: ['id'],
  },
  {
    name: 'create_lambda_function',
    description: 'Create a new Lambda function.',
    properties: {
      name: { type: 'string', description: 'Function name' },
      runtime: { type: 'string', enum: ['node', 'python', 'sh'], description: 'Runtime' },
      code: { type: 'string', description: 'Function source code' },
      packages: { type: 'string', description: 'Space-separated package list' },
      entryPoint: { type: 'string', description: 'Entry-point filename' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'File content' } },
          required: ['path', 'content'],
        },
        description: 'Additional files',
      },
      description: { type: 'string', description: 'Description' },
      projectId: { type: 'string', description: 'Project ID' },
    },
    required: ['name'],
  },
  {
    name: 'update_lambda_function',
    description: 'Update an existing Lambda function.',
    properties: {
      id: { type: 'string', description: 'Function ID' },
      name: { type: 'string', description: 'Function name' },
      runtime: { type: 'string', enum: ['node', 'python', 'sh'], description: 'Runtime' },
      code: { type: 'string', description: 'Source code' },
      packages: { type: 'string', description: 'Space-separated packages' },
      entryPoint: { type: 'string', description: 'Entry filename' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'File content' } },
          required: ['path', 'content'],
        },
        description: 'Additional files',
      },
      description: { type: 'string', description: 'Description' },
      projectId: { type: 'string', description: 'Project ID (null to clear)' },
    },
    required: ['id'],
  },
  {
    name: 'delete_lambda_function',
    description: 'Delete a Lambda function.',
    properties: { id: { type: 'string', description: 'Function ID' } },
    required: ['id'],
  },
  {
    name: 'run_function',
    description: 'Execute a Lambda function (saved or ad-hoc).',
    properties: {
      runtime: { type: 'string', enum: ['node', 'python', 'sh'], description: 'Runtime' },
      code: { type: 'string', description: 'Source code' },
      packages: { type: 'string', description: 'Space-separated packages' },
      functionId: { type: 'string', description: 'Saved function ID' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'File content' } },
          required: ['path', 'content'],
        },
        description: 'Additional files',
      },
      entryPoint: { type: 'string', description: 'Entry filename' },
      payload: { type: 'object', description: 'JSON payload passed to function' },
    },
  },
];

// ── Images (3) ──────────────────────────────────────────────────

const IMAGE_TOOLS: ToolSchema[] = [
  { name: 'list_images', description: 'List all Docker images.', properties: {} },
  {
    name: 'delete_image',
    description: 'Delete a Docker image.',
    properties: {
      id: { type: 'string', description: 'Image ID' },
      force: { type: 'boolean', description: 'Force deletion' },
    },
    required: ['id'],
  },
  { name: 'prune_images', description: 'Prune dangling images and stopped containers.', properties: {} },
];

// ── System (4) ──────────────────────────────────────────────────

const SYSTEM_TOOLS: ToolSchema[] = [
  { name: 'system_ping', description: 'Ping the Docker daemon.', properties: {} },
  { name: 'list_presets', description: 'List container launch presets.', properties: {} },
  { name: 'list_used_ports', description: 'List ports published by running containers.', properties: {} },
  { name: 'prune_build_cache', description: 'Prune the Docker build cache.', properties: {} },
];

// ── Host (4) ────────────────────────────────────────────────────

const HOST_TOOLS: ToolSchema[] = [
  {
    name: 'list_host_directory',
    description: 'List files and directories on the host machine.',
    properties: { sourcePath: { type: 'string', description: 'Absolute host directory path' } },
    required: ['sourcePath'],
  },
  {
    name: 'read_host_file',
    description: 'Read a text file from the host machine.',
    properties: { sourcePath: { type: 'string', description: 'Absolute host file path' } },
    required: ['sourcePath'],
  },
  {
    name: 'copy_host_file_to_container',
    description: 'Copy a file from the host to a running container.',
    properties: {
      sourcePath: { type: 'string', description: 'Host file path' },
      id: { type: 'string', description: 'Container ID' },
      path: { type: 'string', description: 'Destination path in container' },
    },
    required: ['sourcePath', 'id', 'path'],
  },
  {
    name: 'copy_host_file_to_bucket',
    description: 'Copy a file from the host to a bucket.',
    properties: {
      sourcePath: { type: 'string', description: 'Host file path' },
      bucket: { type: 'string', description: 'Bucket name' },
      key: { type: 'string', description: 'Object key' },
      contentType: { type: 'string', description: 'Content type' },
    },
    required: ['sourcePath', 'bucket', 'key'],
  },
];

// ── Host builds (2) ─────────────────────────────────────────────

const HOST_BUILD_TOOLS: ToolSchema[] = [
  { name: 'list_host_build_presets', description: 'List configured host build presets.', properties: {} },
  {
    name: 'run_host_build_preset',
    description: 'Run a host build preset and deploy artifacts to a container.',
    properties: {
      preset: { type: 'string', description: 'Build preset name' },
      id: { type: 'string', description: 'Target container ID' },
      path: { type: 'string', description: 'Destination path in container' },
    },
    required: ['preset', 'id', 'path'],
  },
];

// ── Databases (16) ──────────────────────────────────────────────

const DATABASE_TOOLS: ToolSchema[] = [
  { name: 'list_database_connections', description: 'List saved database connections.', properties: {} },
  {
    name: 'get_database_connection',
    description: 'Get details for a saved database connection.',
    properties: { connectionId: { type: 'string', description: 'Connection ID' } },
    required: ['connectionId'],
  },
  { name: 'get_database_operations_overview', description: 'Get overview of database engine capabilities.', properties: {} },
  {
    name: 'inspect_database_schema',
    description: 'Inspect the schema of a database connection.',
    properties: {
      connectionId: { type: 'string', description: 'Connection ID' },
      database: { type: 'string', description: 'Database name' },
    },
    required: ['connectionId'],
  },
  {
    name: 'run_database_read_query',
    description: 'Run a read-only SQL query or MongoDB find/aggregate/count.',
    properties: {
      connectionId: { type: 'string', description: 'Connection ID' },
      sql: { type: 'string', description: 'MySQL only: one read-only SQL statement' },
      database: { type: 'string', description: 'MongoDB only: optional database override' },
      collection: { type: 'string', description: 'MongoDB only: collection name' },
      mode: { type: 'string', enum: ['find', 'aggregate', 'count'], description: 'MongoDB only; defaults to find' },
      filter: { type: 'object', description: 'MongoDB find/count filter' },
      projection: { type: 'object', description: 'MongoDB find projection' },
      sort: { type: 'object', description: 'MongoDB find sort' },
      limit: { type: 'number', description: 'MongoDB read limit; server caps it' },
      pipeline: { type: 'array', description: 'MongoDB aggregate pipeline', items: { type: 'object' } },
    },
    required: ['connectionId'],
  },
  {
    name: 'list_database_jobs',
    description: 'List database backup/restore jobs.',
    properties: { limit: { type: 'number', description: 'Max entries' } },
  },
  {
    name: 'get_database_job',
    description: 'Get details for a database job.',
    properties: { jobId: { type: 'string', description: 'Job ID' } },
    required: ['jobId'],
  },
  {
    name: 'create_database_connection',
    description: 'Create a new database connection.',
    properties: {
      name: { type: 'string', description: 'Connection name' },
      engine: { type: 'string', enum: ['mysql', 'mongodb'], description: 'Database engine' },
      config: { type: 'object', description: 'MySQL: {host, port?, database, username, password?, ssl?}. MongoDB field mode: {mode:"fields", host, port?, database, username?, password?, authDatabase?, directConnection?, tls?}. MongoDB URI mode: {mode:"uri", uri, database}.' },
      projectId: { type: 'string', description: 'Project ID' },
    },
    required: ['name', 'engine', 'config'],
  },
  {
    name: 'update_database_connection',
    description: 'Update a database connection.',
    properties: {
      connectionId: { type: 'string', description: 'Connection ID' },
      name: { type: 'string', description: 'New name' },
      engine: { type: 'string', enum: ['mysql', 'mongodb'], description: 'Database engine' },
      config: { type: 'object', description: 'Updated connection config' },
    },
    required: ['connectionId'],
  },
  {
    name: 'delete_database_connection',
    description: 'Delete a database connection.',
    properties: { connectionId: { type: 'string', description: 'Connection ID' } },
    required: ['connectionId'],
  },
  {
    name: 'test_database_connection',
    description: 'Test a saved database connection.',
    properties: { connectionId: { type: 'string', description: 'Connection ID' } },
    required: ['connectionId'],
  },
  {
    name: 'execute_database_mutation',
    description: 'Execute a mutating SQL statement or MongoDB write.',
    properties: {
      connectionId: { type: 'string', description: 'Connection ID' },
      statement: { type: 'string', description: 'MySQL only: one INSERT/UPDATE/DELETE/REPLACE statement' },
      operation: { type: 'string', enum: ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany'], description: 'MongoDB operation' },
      database: { type: 'string', description: 'Optional database override' },
      collection: { type: 'string', description: 'MongoDB: collection name' },
      document: { type: 'object', description: 'MongoDB insertOne document' },
      documents: { type: 'array', items: { type: 'object' }, description: 'MongoDB insertMany documents' },
      filter: { type: 'object', description: 'MongoDB write filter' },
      update: { type: 'object', description: 'MongoDB update document' },
      upsert: { type: 'boolean', description: 'MongoDB upsert flag' },
    },
    required: ['connectionId'],
  },
  {
    name: 'execute_database_migration',
    description: 'Execute a DDL migration (CREATE/ALTER/DROP or MongoDB steps).',
    properties: {
      connectionId: { type: 'string', description: 'Connection ID' },
      statements: { type: 'array', items: { type: 'string' }, description: 'MySQL migration statements' },
      steps: { type: 'array', items: { type: 'object' }, description: 'MongoDB migration steps' },
    },
    required: ['connectionId'],
  },
  {
    name: 'execute_database_access_grant',
    description: 'Grant or revoke database privileges.',
    properties: {
      connectionId: { type: 'string', description: 'Connection ID' },
      username: { type: 'string', description: 'Target MySQL or MongoDB username' },
      host: { type: 'string', description: 'MySQL only: account host, e.g. localhost or %' },
      privileges: { type: 'array', items: { type: 'string' }, description: 'MySQL only: privilege names' },
      database: { type: 'string', description: 'MySQL only: database scope, or * for global' },
      table: { type: 'string', description: 'MySQL only: optional table scope' },
      withGrantOption: { type: 'boolean', description: 'MySQL only: append WITH GRANT OPTION' },
      authDatabase: { type: 'string', description: 'MongoDB only: database owning the target user' },
      roles: {
        type: 'array',
        description: 'MongoDB only: built-in role strings or {role, db} objects',
        items: {
          anyOf: [
            { type: 'string' },
            { type: 'object', properties: { role: { type: 'string' }, db: { type: 'string' } }, required: ['role', 'db'] },
          ],
        },
      },
    },
    required: ['connectionId', 'username'],
  },
  {
    name: 'create_database_backup',
    description: 'Create a backup of a database.',
    properties: {
      connectionId: { type: 'string', description: 'Connection ID' },
      database: { type: 'string', description: 'Optional database override' },
    },
    required: ['connectionId'],
  },
  {
    name: 'restore_database_backup',
    description: 'Restore a database from a backup.',
    properties: {
      connectionId: { type: 'string', description: 'Connection ID' },
      jobId: { type: 'string', description: 'Backup job ID' },
      targetDatabase: { type: 'string', description: 'Target database name' },
    },
    required: ['connectionId', 'jobId'],
  },
];

// ── Projects (4) ────────────────────────────────────────────────

const PROJECT_TOOLS: ToolSchema[] = [
  { name: 'list_projects', description: 'List all projects with resource summaries.', properties: {} },
  {
    name: 'create_project',
    description: 'Create a new project.',
    properties: {
      name: { type: 'string', description: 'Project name' },
      description: { type: 'string', description: 'Optional description' },
    },
    required: ['name'],
  },
  {
    name: 'update_project',
    description: 'Update a project.',
    properties: {
      id: { type: 'string', description: 'Project ID' },
      name: { type: 'string', description: 'New name' },
      description: { type: 'string', description: 'New description' },
    },
    required: ['id'],
  },
  {
    name: 'delete_project',
    description: 'Delete a project.',
    properties: { id: { type: 'string', description: 'Project ID' } },
    required: ['id'],
  },
];

// ── Volumes (1) ─────────────────────────────────────────────────

const VOLUME_TOOLS: ToolSchema[] = [
  { name: 'list_volumes', description: 'List Docker volumes.', properties: {} },
];

// ── GitHub (5) ──────────────────────────────────────────────────

const GITHUB_TOOLS: ToolSchema[] = [
  {
    name: 'list_github_repo_files',
    description: 'List files in a GitHub repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      path: { type: 'string', description: 'Directory path' },
      ref: { type: 'string', description: 'Git ref (branch, tag, or commit SHA)' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'read_github_file',
    description: 'Read a file from a GitHub repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      path: { type: 'string', description: 'File path' },
      ref: { type: 'string', description: 'Git ref (branch, tag, or commit SHA)' },
    },
    required: ['owner', 'repo', 'path'],
  },
  {
    name: 'pull_github_repo_to_bucket',
    description: 'Pull a GitHub repository into a bucket.',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      bucket: { type: 'string', description: 'Target bucket name' },
      prefix: { type: 'string', description: 'Key prefix' },
      ref: { type: 'string', description: 'Git ref (branch, tag, or commit SHA)' },
      clean: { type: 'boolean', description: 'Delete destination first' },
    },
    required: ['owner', 'repo', 'bucket'],
  },
  {
    name: 'pull_github_repo_to_container',
    description: 'Pull a GitHub repository into a container.',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      id: { type: 'string', description: 'Container ID' },
      path: { type: 'string', description: 'Destination path in container' },
      ref: { type: 'string', description: 'Git ref (branch, tag, or commit SHA)' },
      clean: { type: 'boolean', description: 'Delete destination first' },
    },
    required: ['owner', 'repo', 'id', 'path'],
  },
  {
    name: 'commit_and_push_github_files',
    description: 'Commit and push files to a GitHub repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      ref: { type: 'string', description: 'Git ref (branch, tag, or commit SHA)' },
      branch: { type: 'string', description: 'Branch to commit to. If it does not exist, it will be created from the default branch or baseBranch.' },
      baseBranch: { type: 'string', description: 'Base branch to create the target branch from when it does not exist on the remote' },
      message: { type: 'string', description: 'Commit message' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'File content' } },
          required: ['path', 'content'],
        },
        description: 'Files to commit',
      },
    },
    required: ['owner', 'repo', 'message', 'files'],
  },
  {
    name: 'get_github_workflow_status',
    description: 'Get GitHub Actions workflow status for a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
    },
    required: ['owner', 'repo'],
  },
];

// ── Aggregate & export ──────────────────────────────────────────

export const COMMON_TOOL_SCHEMAS: ToolSchema[] = [
  ...CONTAINER_TOOLS,
  ...BUCKET_TOOLS,
  ...GATEWAY_TOOLS,
  ...LAMBDA_TOOLS,
  ...IMAGE_TOOLS,
  ...SYSTEM_TOOLS,
  ...HOST_TOOLS,
  ...HOST_BUILD_TOOLS,
  ...DATABASE_TOOLS,
  ...PROJECT_TOOLS,
  ...VOLUME_TOOLS,
  ...GITHUB_TOOLS,
];

export const COMMON_TOOL_NAMES = new Set(COMMON_TOOL_SCHEMAS.map((t) => t.name));

// Map from shared schema to assistant-native format (input_schema).
export function toAssistantSchema(t: ToolSchema): {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
} {
  return {
    name: t.name,
    description: t.description,
    input_schema: { type: 'object', properties: t.properties as Record<string, unknown>, ...(t.required ? { required: t.required } : {}) },
  };
}

// Map from shared schema to MCP-native format (inputSchema).
export function toMcpSchema(t: ToolSchema): {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, object>; required?: string[] };
} {
  return {
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object' as const, properties: t.properties as Record<string, object>, ...(t.required ? { required: t.required } : {}) },
  };
}

// Build assistant-native tool definitions, overlaying Claude-optimised descriptions.
// `descriptions` maps tool name → assistant-specific description.
// `extra` contains assistant-only tools (wait, issues, consumer, etc).
// `excludeNames` lists tool names provided by separate modules (DATABASE_ASSISTANT_TOOLS, etc).
export function buildAssistantTools(
  descriptions: Record<string, string>,
  extra: Array<{
    name: string;
    description: string;
    input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  }>,
  excludeNames: Set<string> = new Set(),
) {
  return [
    ...COMMON_TOOL_SCHEMAS
      .filter((t) => !excludeNames.has(t.name))
      .map((t) => ({
        name: t.name,
        description: descriptions[t.name] || t.description,
        input_schema: {
          type: 'object' as const,
          properties: t.properties as Record<string, unknown>,
          ...(t.required?.length ? { required: t.required } : {}),
        },
      })),
    ...extra,
  ];
}
