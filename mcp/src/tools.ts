import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const TOOL_DEFINITIONS: Tool[] = [
  // ── Containers (14) ─────────────────────────────────────────
  {
    name: 'list_containers',
    description: 'List all Docker containers. Optionally filter by project.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Filter containers by project ID' },
      },
    },
  },
  {
    name: 'launch_container',
    description: 'Launch a new Docker container from a preset or image.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        presetId: { type: 'string', description: 'Preset ID to use' },
        image: { type: 'string', description: 'Docker image to use' },
        name: { type: 'string', description: 'Container name' },
        description: { type: 'string', description: 'Human-readable description' },
        protected: { type: 'boolean', description: 'Prevent accidental deletion' },
        projectId: { type: 'string', description: 'Project to associate this container with' },
        command: { type: 'array', items: { type: 'string' }, description: 'Command to run' },
        ports: {
          type: 'array',
          items: {
            type: 'object',
            properties: { container: { type: 'string' }, host: { type: 'number' } },
            required: ['container', 'host'],
          },
          description: 'Port mappings',
        },
        env: {
          type: 'array',
          items: {
            type: 'object',
            properties: { key: { type: 'string' }, value: { type: 'string' } },
            required: ['key', 'value'],
          },
          description: 'Environment variables',
        },
        volumes: { type: 'array', items: { type: 'string' }, description: 'Volume mounts (e.g. "mydata:/app/data")' },
        autoStart: { type: 'boolean', description: 'Start the container after creation (default: true)' },
      },
    },
  },
  {
    name: 'inspect_container',
    description: 'Get full details about a Docker container.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Container ID' } },
      required: ['id'],
    },
  },
  {
    name: 'container_action',
    description: 'Start, stop, or restart a container.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Container ID' },
        action: { type: 'string', enum: ['start', 'stop', 'restart'], description: 'Action to perform' },
      },
      required: ['id', 'action'],
    },
  },
  {
    name: 'delete_container',
    description: 'Remove a Docker container.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Container ID' },
        force: { type: 'boolean', description: 'Force removal' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_container_logs',
    description: 'Get logs from a Docker container.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Container ID' },
        tail: { type: 'number', description: 'Number of lines to fetch from the end' },
      },
      required: ['id'],
    },
  },
  {
    name: 'update_container_env',
    description: 'Update environment variables and/or description on a container (recreates it).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Container ID' },
        env: {
          type: 'array',
          items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] },
          description: 'Environment variables to set',
        },
        persist: { type: 'boolean', description: 'Snapshot filesystem before recreating' },
        description: { type: 'string', description: 'New description text' },
        protected: { type: 'boolean', description: 'Set protected flag' },
        projectId: { type: 'string', description: 'Assign to project (null to clear)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'execute_container_command',
    description: 'Execute a command in a running container.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Container ID' },
        command: { type: 'array', items: { type: 'string' }, description: 'Command and arguments' },
        workingDir: { type: 'string', description: 'Working directory inside the container' },
        background: { type: 'boolean', description: 'Run in background and return execId' },
        timeoutSeconds: { type: 'number', description: 'Timeout in seconds (1-600)' },
      },
      required: ['id', 'command'],
    },
  },
  {
    name: 'get_container_exec_output',
    description: 'Get output from a background exec.',
    inputSchema: {
      type: 'object' as const,
      properties: { execId: { type: 'string', description: 'Exec ID from execute_container_command' } },
      required: ['execId'],
    },
  },
  {
    name: 'write_container_file',
    description: 'Write a file to a running container.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Container ID' },
        path: { type: 'string', description: 'Absolute path inside the container' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['id', 'path'],
    },
  },
  {
    name: 'write_container_files',
    description: 'Write multiple files to a running container in one call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Container ID' },
        files: {
          type: 'array',
          items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
          description: 'Array of { path, content } objects',
        },
      },
      required: ['id', 'files'],
    },
  },
  {
    name: 'replace_in_container_file',
    description: 'Search and replace text in a container file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Container ID' },
        path: { type: 'string', description: 'Absolute path inside the container' },
        search: { type: 'string', description: 'String to search for' },
        replace: { type: 'string', description: 'Replacement string' },
      },
      required: ['id', 'path', 'search'],
    },
  },
  {
    name: 'list_container_files',
    description: 'List files in a container directory.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Container ID' },
        path: { type: 'string', description: 'Directory path (default: /)' },
        maxDepth: { type: 'number', description: 'Max recursion depth (default: 4)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'probe_container_endpoint',
    description: 'Probe an HTTP endpoint inside a container.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Container ID' },
        port: { type: 'number', description: 'Port to probe' },
        path: { type: 'string', description: 'URL path (default: /)' },
        method: { type: 'string', description: 'HTTP method (default: GET)' },
      },
      required: ['id', 'port'],
    },
  },

  // ── Buckets (10) ────────────────────────────────────────────
  {
    name: 'list_buckets',
    description: 'List all S3/MinIO buckets with stats.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Filter by project ID' },
      },
    },
  },
  {
    name: 'create_bucket',
    description: 'Create a new S3/MinIO bucket.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Bucket name' },
        protected: { type: 'boolean', description: 'Prevent accidental deletion' },
      },
      required: ['name'],
    },
  },
  {
    name: 'delete_bucket',
    description: 'Delete an S3/MinIO bucket.',
    inputSchema: {
      type: 'object' as const,
      properties: { name: { type: 'string', description: 'Bucket name' } },
      required: ['name'],
    },
  },
  {
    name: 'update_bucket',
    description: 'Toggle protected status on a bucket.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Bucket name' },
        protected: { type: 'boolean', description: 'Protected flag' },
      },
      required: ['name', 'protected'],
    },
  },
  {
    name: 'list_bucket_objects',
    description: 'List objects in a bucket with optional prefix filtering.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Bucket name' },
        prefix: { type: 'string', description: 'Prefix filter' },
      },
      required: ['name'],
    },
  },
  {
    name: 'read_bucket_object',
    description: 'Read an object from a bucket as text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Bucket name' },
        key: { type: 'string', description: 'Object key' },
      },
      required: ['name', 'key'],
    },
  },
  {
    name: 'write_bucket_object',
    description: 'Write a text object to a bucket.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Bucket name' },
        key: { type: 'string', description: 'Object key' },
        content: { type: 'string', description: 'Object content' },
        contentType: { type: 'string', description: 'Content type (default: text/plain)' },
      },
      required: ['name', 'key', 'content'],
    },
  },
  {
    name: 'write_bucket_objects',
    description: 'Write multiple objects to a bucket in one call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Bucket name' },
        objects: {
          type: 'array',
          items: { type: 'object', properties: { key: { type: 'string' }, content: { type: 'string' }, contentType: { type: 'string' } }, required: ['key', 'content'] },
          description: 'Array of { key, content, contentType? } objects',
        },
      },
      required: ['name', 'objects'],
    },
  },
  {
    name: 'delete_bucket_object',
    description: 'Delete an object from a bucket.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Bucket name' },
        key: { type: 'string', description: 'Object key' },
      },
      required: ['name', 'key'],
    },
  },
  {
    name: 'replace_in_bucket_object',
    description: 'Search and replace text in a bucket object.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Bucket name' },
        key: { type: 'string', description: 'Object key' },
        search: { type: 'string', description: 'String to find' },
        replace: { type: 'string', description: 'Replacement string' },
      },
      required: ['name', 'key', 'search'],
    },
  },

  // ── Gateway (5) ─────────────────────────────────────────────
  {
    name: 'list_gateway_routes',
    description: 'List all gateway routes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Filter by project ID' },
      },
    },
  },
  {
    name: 'create_gateway_route',
    description: 'Create a new gateway route.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Route name (URL segment)' },
        displayName: { type: 'string', description: 'Human-readable display name' },
        targetType: { type: 'string', enum: ['bucket', 'container', 'lambda'], description: 'Target type' },
        targetId: { type: 'string', description: 'Target resource ID' },
        targetPort: { type: 'number', description: 'Target port (required for containers)' },
        method: { type: 'string', description: 'HTTP method filter' },
        pathPattern: { type: 'string', description: 'URL path pattern' },
        projectId: { type: 'string', description: 'Project to associate' },
      },
      required: ['name', 'targetType', 'targetId'],
    },
  },
  {
    name: 'update_gateway_route',
    description: 'Update a gateway route.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Route ID' },
        displayName: { type: 'string', description: 'New display name' },
        method: { type: 'string', description: 'HTTP method' },
        pathPattern: { type: 'string', description: 'Path pattern (null to clear)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_gateway_route',
    description: 'Delete a gateway route.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Route ID' } },
      required: ['id'],
    },
  },
  {
    name: 'manage_gateway_domain',
    description: 'Set or remove a domain for a gateway route.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Route ID' },
        domain: { type: 'string', description: 'Domain name (null to remove)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'manage_dns_records',
    description: 'Create or delete DNS records in Route 53.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        zoneId: { type: 'string', description: 'Route 53 hosted zone ID' },
        action: { type: 'string', enum: ['create', 'delete'], description: 'Action' },
        name: { type: 'string', description: 'Record name' },
      },
      required: ['zoneId', 'action', 'name'],
    },
  },

  // ── Lambda (5) ──────────────────────────────────────────────
  {
    name: 'list_functions',
    description: 'List all saved lambda functions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Filter by project ID' },
      },
    },
  },
  {
    name: 'read_function',
    description: 'Get a saved lambda function by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Function ID' } },
      required: ['id'],
    },
  },
  {
    name: 'create_lambda_function',
    description: 'Create a new lambda function.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Function name' },
        runtime: { type: 'string', enum: ['node', 'python', 'sh'], description: 'Runtime' },
        code: { type: 'string', description: 'Function source code' },
        packages: { type: 'string', description: 'Space-separated package list' },
        entryPoint: { type: 'string', description: 'Entry-point filename' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }, description: 'Additional files' },
        description: { type: 'string', description: 'Description' },
        projectId: { type: 'string', description: 'Project ID' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_lambda_function',
    description: 'Update an existing lambda function.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Function ID' },
        name: { type: 'string' },
        runtime: { type: 'string', enum: ['node', 'python', 'sh'] },
        code: { type: 'string' },
        packages: { type: 'string' },
        entryPoint: { type: 'string' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
        description: { type: 'string' },
        projectId: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_lambda_function',
    description: 'Delete a lambda function.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Function ID' } },
      required: ['id'],
    },
  },
  {
    name: 'run_lambda_function',
    description: 'Execute a lambda function (saved or ad-hoc code).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        runtime: { type: 'string', enum: ['node', 'python', 'sh'], description: 'Runtime' },
        code: { type: 'string', description: 'Source code' },
        packages: { type: 'string', description: 'Space-separated packages' },
        functionId: { type: 'string', description: 'Saved function ID (uses its code + env)' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
        entryPoint: { type: 'string', description: 'Entry filename' },
        payload: { type: 'object', description: 'JSON payload passed to function' },
      },
    },
  },

  // ── Images (3) ──────────────────────────────────────────────
  {
    name: 'list_images',
    description: 'List all Docker images.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'delete_image',
    description: 'Delete a Docker image.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Image ID' },
        force: { type: 'boolean', description: 'Force deletion' },
      },
      required: ['id'],
    },
  },
  {
    name: 'prune_images',
    description: 'Prune dangling images and stopped containers.',
    inputSchema: { type: 'object' as const, properties: {} },
  },

  // ── System (4) ──────────────────────────────────────────────
  {
    name: 'system_ping',
    description: 'Ping the Docker daemon.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_presets',
    description: 'List container launch presets.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_used_ports',
    description: 'List ports currently published by running containers.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'prune_build_cache',
    description: 'Prune the Docker build cache.',
    inputSchema: { type: 'object' as const, properties: {} },
  },

  // ── Host (4) ────────────────────────────────────────────────
  {
    name: 'list_host_directory',
    description: 'List files/directories on the host machine.',
    inputSchema: {
      type: 'object' as const,
      properties: { sourcePath: { type: 'string', description: 'Absolute host directory path' } },
      required: ['sourcePath'],
    },
  },
  {
    name: 'read_host_file',
    description: 'Read a text file from the host machine.',
    inputSchema: {
      type: 'object' as const,
      properties: { sourcePath: { type: 'string', description: 'Absolute host file path' } },
      required: ['sourcePath'],
    },
  },
  {
    name: 'copy_host_file_to_container',
    description: 'Copy a file from the host to a running container.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sourcePath: { type: 'string', description: 'Host file path' },
        id: { type: 'string', description: 'Container ID' },
        path: { type: 'string', description: 'Destination path in container' },
      },
      required: ['sourcePath', 'id', 'path'],
    },
  },
  {
    name: 'copy_host_file_to_bucket',
    description: 'Copy a file from the host to an S3/MinIO bucket.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sourcePath: { type: 'string', description: 'Host file path' },
        bucket: { type: 'string', description: 'Bucket name' },
        key: { type: 'string', description: 'Object key' },
        contentType: { type: 'string', description: 'Content type' },
      },
      required: ['sourcePath', 'bucket', 'key'],
    },
  },

  // ── Host builds (2) ─────────────────────────────────────────
  {
    name: 'list_host_build_presets',
    description: 'List configured host build presets.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'run_host_build_preset',
    description: 'Run a host build preset and deploy artifacts to a container.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        preset: { type: 'string', description: 'Build preset name' },
        id: { type: 'string', description: 'Target container ID' },
        path: { type: 'string', description: 'Destination path in container' },
      },
      required: ['preset', 'id', 'path'],
    },
  },

  // ── Databases (12) ──────────────────────────────────────────
  {
    name: 'list_database_connections',
    description: 'List saved database connections.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Filter by project ID' },
      },
    },
  },
  {
    name: 'get_database_connection',
    description: 'Get details for a saved database connection.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Connection ID' } },
      required: ['id'],
    },
  },
  {
    name: 'get_database_operations_overview',
    description: 'Get an overview of database engine capabilities.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'inspect_database_schema',
    description: 'Inspect the schema of a database connection.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Connection ID' },
        database: { type: 'string', description: 'Database name' },
      },
      required: ['id'],
    },
  },
  {
    name: 'run_database_read_query',
    description: 'Run a read-only SQL query or MongoDB find/aggregate.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connectionId: { type: 'string', description: 'Connection ID' },
        query: { type: 'string', description: 'SQL query' },
        collection: { type: 'string', description: 'MongoDB collection' },
        filter: { type: 'object', description: 'MongoDB filter' },
        limit: { type: 'number', description: 'Row/result limit' },
      },
      required: ['connectionId'],
    },
  },
  {
    name: 'test_database_connection',
    description: 'Test a saved database connection.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Connection ID' } },
      required: ['id'],
    },
  },
  {
    name: 'create_database_connection',
    description: 'Create a new database connection.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Connection name' },
        engine: { type: 'string', enum: ['mysql', 'mongodb'], description: 'Database engine' },
        host: { type: 'string', description: 'Hostname' },
        port: { type: 'number', description: 'Port' },
        database: { type: 'string', description: 'Database name' },
        username: { type: 'string', description: 'Username' },
        password: { type: 'string', description: 'Password' },
        projectId: { type: 'string', description: 'Project ID' },
      },
      required: ['name', 'engine'],
    },
  },
  {
    name: 'update_database_connection',
    description: 'Update a database connection.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Connection ID' },
        name: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'number' },
        database: { type: 'string' },
        username: { type: 'string' },
        password: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_database_connection',
    description: 'Delete a database connection.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Connection ID' } },
      required: ['id'],
    },
  },
  {
    name: 'execute_database_mutation',
    description: 'Execute a mutating SQL statement or MongoDB write operation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connectionId: { type: 'string', description: 'Connection ID' },
        confirm: { type: 'boolean', description: 'Must be true to execute' },
        query: { type: 'string', description: 'SQL statement' },
        confirmed: { type: 'boolean', description: 'Confirmation flag' },
      },
      required: ['connectionId', 'confirmed'],
    },
  },
  {
    name: 'execute_database_migration',
    description: 'Execute a DDL migration (CREATE/ALTER/DROP).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connectionId: { type: 'string', description: 'Connection ID' },
        confirmed: { type: 'boolean', description: 'Confirmation flag' },
        query: { type: 'string', description: 'DDL statement' },
      },
      required: ['connectionId', 'confirmed'],
    },
  },
  {
    name: 'execute_database_access_grant',
    description: 'Grant or revoke database privileges.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connectionId: { type: 'string', description: 'Connection ID' },
        confirmed: { type: 'boolean', description: 'Confirmation flag' },
        privileges: { type: 'array', items: { type: 'string' }, description: 'Privileges to grant' },
        username: { type: 'string', description: 'Target username' },
        database: { type: 'string', description: 'Target database' },
        table: { type: 'string', description: 'Target table' },
      },
      required: ['connectionId', 'confirmed'],
    },
  },
  {
    name: 'create_database_backup',
    description: 'Create a backup of a database.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connectionId: { type: 'string', description: 'Connection ID' },
        confirmed: { type: 'boolean', description: 'Confirmation flag' },
        database: { type: 'string', description: 'Database to back up' },
      },
      required: ['connectionId', 'confirmed'],
    },
  },
  {
    name: 'restore_database_backup',
    description: 'Restore a database from a backup.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connectionId: { type: 'string', description: 'Connection ID' },
        confirmed: { type: 'boolean', description: 'Confirmation flag' },
        jobId: { type: 'string', description: 'Backup job ID' },
        targetDatabase: { type: 'string', description: 'Target database name' },
      },
      required: ['connectionId', 'confirmed', 'jobId'],
    },
  },
  {
    name: 'list_database_jobs',
    description: 'List database backup/restore jobs.',
    inputSchema: {
      type: 'object' as const,
      properties: { limit: { type: 'number', description: 'Max entries' } },
    },
  },
  {
    name: 'get_database_job',
    description: 'Get details for a database job.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Job ID' } },
      required: ['id'],
    },
  },

  // ── Projects (4) ────────────────────────────────────────────
  {
    name: 'list_projects',
    description: 'List all projects.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'create_project',
    description: 'Create a new project.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Project name' },
        description: { type: 'string', description: 'Description' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_project',
    description: 'Update a project.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Project ID' },
        name: { type: 'string', description: 'New name' },
        description: { type: 'string', description: 'New description' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_project',
    description: 'Delete a project.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Project ID' } },
      required: ['id'],
    },
  },

  // ── Volumes (1) ─────────────────────────────────────────────
  {
    name: 'list_volumes',
    description: 'List Docker volumes.',
    inputSchema: { type: 'object' as const, properties: {} },
  },

  // ── GitHub (5) ──────────────────────────────────────────────
  {
    name: 'list_github_repo_files',
    description: 'List files in a GitHub repository.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository (owner/repo)' },
        path: { type: 'string', description: 'Directory path' },
        branch: { type: 'string', description: 'Branch name' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'read_github_file',
    description: 'Read a file from a GitHub repository.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository (owner/repo)' },
        path: { type: 'string', description: 'File path' },
        branch: { type: 'string', description: 'Branch name' },
      },
      required: ['repo', 'path'],
    },
  },
  {
    name: 'pull_github_repo_to_bucket',
    description: 'Pull a GitHub repository into a bucket.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository (owner/repo)' },
        bucket: { type: 'string', description: 'Target bucket name' },
        prefix: { type: 'string', description: 'Key prefix' },
        branch: { type: 'string', description: 'Branch name' },
      },
      required: ['repo', 'bucket'],
    },
  },
  {
    name: 'pull_github_repo_to_container',
    description: 'Pull a GitHub repository into a container.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository (owner/repo)' },
        id: { type: 'string', description: 'Container ID' },
        path: { type: 'string', description: 'Destination path in container' },
        branch: { type: 'string', description: 'Branch name' },
      },
      required: ['repo', 'id', 'path'],
    },
  },
  {
    name: 'commit_and_push_github_files',
    description: 'Commit and push files to a GitHub repository.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository (owner/repo)' },
        branch: { type: 'string', description: 'Branch name' },
        message: { type: 'string', description: 'Commit message' },
        files: {
          type: 'array',
          items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        },
      },
      required: ['repo', 'branch', 'message', 'files'],
    },
  },
];
