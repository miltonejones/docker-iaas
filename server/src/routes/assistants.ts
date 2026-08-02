import { Router, type Request, type Response } from 'express';
import { getAuthUser } from '../auth.js';
import * as assistantsService from '../services/assistants.js';

function sendError(res: Response, err: unknown) {
  const status = (err as { status?: number }).status || 500;
  res.status(status).json({ error: (err as Error).message || 'Unknown error.' });
}

export const assistantsRouter = Router();

// Mount BEFORE /:id so 'meta' is not swallowed as an id.

/** The canonical tool category map. When adding a tool to assistant-tools.ts,
 *  add it here too — the registry-walk test enforces this. */
export const TOOL_CATEGORIES: Record<string, string[]> = {
  'Containers': ['list_containers', 'launch_container', 'container_action', 'inspect_container', 'get_container_logs', 'write_container_file', 'write_container_files', 'replace_in_container_file', 'read_container_file', 'list_container_files', 'execute_container_command', 'get_container_exec_output', 'probe_container_endpoint', 'update_container_env', 'delete_container', 'copy_to_container'],
  'Functions': ['list_functions', 'create_lambda_function', 'read_function', 'update_lambda_function', 'delete_lambda_function', 'run_function', 'replace_lambda_function_files'],
  'Gateway & DNS': ['list_gateway_routes', 'create_gateway_route', 'update_gateway_route', 'delete_gateway_route', 'check_gateway_domain_status', 'set_gateway_domain', 'enable_gateway_domain', 'remove_gateway_domain', 'list_dns_zones', 'list_dns_records', 'create_dns_record', 'delete_dns_record'],
  'Buckets': ['list_buckets', 'create_bucket', 'delete_bucket', 'update_bucket', 'list_bucket_objects', 'read_bucket_object', 'write_bucket_object', 'write_bucket_objects', 'replace_in_bucket_object', 'delete_bucket_object', 'copy_host_file_to_bucket'],
  'Images': ['list_images', 'delete_image', 'prune_images', 'prune_build_cache'],
  'Database': ['list_database_connections', 'get_database_connection', 'get_database_operations_overview', 'inspect_database_schema', 'run_database_read_query', 'test_database_connection', 'create_database_connection', 'update_database_connection', 'delete_database_connection', 'execute_database_mutation', 'execute_database_migration', 'execute_database_access_grant', 'create_database_backup', 'restore_database_backup', 'list_database_jobs', 'get_database_job'],
  'Projects': ['list_projects', 'create_project', 'update_project', 'delete_project', 'get_project_manifest', 'get_manifest_drift', 'capture_project_manifest'],
  'GitHub': ['get_github_workflow_status', 'list_github_repo_files', 'read_github_file', 'pull_github_repo_to_bucket', 'pull_github_repo_to_container', 'commit_and_push_github_files'],
  'Host & System': ['list_presets', 'list_used_ports', 'list_images', 'system_ping', 'list_volumes', 'list_host_directory', 'read_host_file', 'list_host_build_presets', 'run_host_build_preset', 'copy_host_file_to_container'],
  'Issues': ['list_issues', 'get_issue', 'report_issue', 'update_issue', 'delete_issue', 'clear_issues'],
  'Automation': ['wait', 'get_consumer_status', 'get_consumer_activity', 'check_consumer_health', 'retry_issue'],
};

assistantsRouter.get('/meta', async (_req: Request, res: Response) => {
  try {
    // Dynamic imports break the routes/assistants ↔ routes/assistant cycle.
    const { tools } = await import('../assistant-tools.js');
    const { READ_ONLY_TOOLS } = await import('./assistant.js');
    res.json({
      tools: tools.map((t: any) => ({
        name: t.name,
        description: t.description || '',
        category: Object.entries(TOOL_CATEGORIES).find(([, names]) => names.includes(t.name))?.[0] || 'Other',
        readOnly: READ_ONLY_TOOLS.has(t.name),
      })),
      alwaysIncluded: ['wait'],
    });
  } catch (err) { sendError(res, err); }
});

assistantsRouter.get('/', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }
    res.json(assistantsService.list(userId));
  } catch (err) { sendError(res, err); }
});

assistantsRouter.get('/:id', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }
    res.json(assistantsService.get(req.params.id, userId));
  } catch (err) { sendError(res, err); }
});

assistantsRouter.post('/', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }
    res.status(201).json(assistantsService.create(userId, req.body));
  } catch (err) { sendError(res, err); }
});

assistantsRouter.put('/:id', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }
    res.json(assistantsService.update(req.params.id, userId, req.body));
  } catch (err) { sendError(res, err); }
});

assistantsRouter.delete('/:id', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }
    res.json(assistantsService.remove(req.params.id, userId));
  } catch (err) { sendError(res, err); }
});
