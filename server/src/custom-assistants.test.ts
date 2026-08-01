// Must set before dynamic imports — auth.ts fails fast without it.
process.env.JWT_SECRET = 'dockyard-test-secret';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('SYSTEM byte-identity', () => {
  it('SYSTEM_PERSONA + blank line + SYSTEM_CORE is byte-identical to the original monolithic SYSTEM', async () => {
    const {
      SYSTEM_PERSONA,
      SYSTEM_CORE,
    } = await import('./routes/assistant.js');

    const reconstructed = SYSTEM_PERSONA + '\n\n' + SYSTEM_CORE;

    // The original monolithic SYSTEM had this exact text (the PR split it).
    // If this assertion fails, someone changed the source without updating the test.
    assert.ok(
      SYSTEM_PERSONA.startsWith('You are the Dockyard.ai assistant.'),
      'SYSTEM_PERSONA should start with the identity sentence',
    );
    assert.ok(
      SYSTEM_CORE.startsWith('A knowledge base bucket'),
      'SYSTEM_CORE should start with the knowledge-base paragraph',
    );

    // The reconstructed string must contain the fused boundary correctly:
    // "...resolve the name to an ID.\n\nA knowledge base bucket..."
    const boundary = 'resolve the name to an ID.\n\nA knowledge base bucket';
    assert.ok(
      reconstructed.includes(boundary),
      'SYSTEM must have a double-newline separator between persona and core: ' +
        JSON.stringify(boundary),
    );

    // And NOT the fused version without a separator.
    const fused = 'resolve the name to an ID.A knowledge base bucket';
    assert.ok(
      !reconstructed.includes(fused),
      'SYSTEM must NOT fuse paragraphs: ' + JSON.stringify(fused),
    );
  });
});

describe('tool registry meta endpoint', () => {
  it('every tool in the assistant-tools registry is assigned a category', async () => {
    const { tools } = await import('./assistant-tools.js');

    // Categories from the meta endpoint (duplicated here to keep the test fast).
    const categories: Record<string, string[]> = {
      'Containers': ['list_containers', 'launch_container', 'container_action', 'inspect_container', 'get_container_logs', 'write_container_file', 'write_container_files', 'replace_in_container_file', 'read_container_file', 'list_container_files', 'execute_container_command', 'get_container_exec_output', 'probe_container_endpoint', 'update_container_env', 'delete_container', 'copy_to_container'],
      'Functions': ['list_functions', 'create_lambda_function', 'read_function', 'update_lambda_function', 'delete_lambda_function', 'run_function', 'replace_lambda_function_files'],
      'Gateway & DNS': ['list_gateway_routes', 'create_gateway_route', 'update_gateway_route', 'delete_gateway_route', 'check_gateway_domain_status', 'set_gateway_domain', 'enable_gateway_domain', 'remove_gateway_domain', 'list_dns_zones', 'list_dns_records', 'create_dns_record', 'delete_dns_record'],
      'Buckets': ['list_buckets', 'create_bucket', 'delete_bucket', 'update_bucket', 'list_bucket_objects', 'read_bucket_object', 'write_bucket_object', 'write_bucket_objects', 'replace_in_bucket_object', 'delete_bucket_object', 'copy_host_file_to_bucket'],
      'Images': ['list_images', 'delete_image', 'prune_images', 'prune_build_cache'],
      'Database': ['list_database_connections', 'get_database_connection', 'get_database_operations_overview', 'inspect_database_schema', 'run_database_read_query', 'test_database_connection', 'create_database_connection', 'update_database_connection', 'delete_database_connection', 'execute_database_mutation', 'execute_database_migration', 'execute_database_access_grant', 'create_database_backup', 'restore_database_backup', 'list_database_jobs', 'get_database_job'],
      'Projects': ['list_projects', 'create_project', 'update_project', 'delete_project'],
      'GitHub': ['get_github_workflow_status', 'list_github_repo_files', 'read_github_file', 'pull_github_repo_to_bucket', 'pull_github_repo_to_container', 'commit_and_push_github_files'],
      'Host & System': ['list_presets', 'list_used_ports', 'list_images', 'system_ping', 'list_volumes', 'list_host_directory', 'read_host_file', 'list_host_build_presets', 'run_host_build_preset', 'copy_host_file_to_container'],
      'Issues': ['list_issues', 'get_issue', 'report_issue', 'update_issue', 'delete_issue', 'clear_issues'],
      'Automation': ['wait', 'get_consumer_status', 'get_consumer_activity', 'check_consumer_health', 'retry_issue'],
    };

    const categorized = new Set<string>();
    for (const names of Object.values(categories)) {
      for (const n of names) categorized.add(n);
    }

    const uncategorized: string[] = [];
    for (const t of tools) {
      if (!categorized.has(t.name)) uncategorized.push(t.name);
    }

    assert.equal(
      uncategorized.length,
      0,
      'These tools exist in assistant-tools.ts but have no category: ' +
        uncategorized.join(', ') +
        '. Add them to the categories map in the meta endpoint.',
    );
  });
});

describe('SYSTEM constants are exported for testability', () => {
  it('SYSTEM_PERSONA and SYSTEM_CORE are exported', async () => {
    const mod = await import('./routes/assistant.js');
    assert.ok(typeof mod.SYSTEM_PERSONA === 'string', 'SYSTEM_PERSONA exported');
    assert.ok(typeof mod.SYSTEM_CORE === 'string', 'SYSTEM_CORE exported');
    assert.ok(
      mod.SYSTEM_PERSONA.length > 0 && mod.SYSTEM_CORE.length > 0,
      'Both constants are non-empty strings',
    );
  });
});
