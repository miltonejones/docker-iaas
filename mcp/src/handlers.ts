import * as containerService from '../../server/src/services/containers.js';
import * as bucketService from '../../server/src/services/buckets.js';
import * as gatewayService from '../../server/src/services/gateway.js';
import * as lambdaService from '../../server/src/services/lambda.js';
import * as imageService from '../../server/src/services/images.js';
import * as systemService from '../../server/src/services/system.js';
import * as projectService from '../../server/src/services/projects.js';
import * as databaseService from '../../server/src/services/databases.js';
import * as hostFileService from '../../server/src/services/host-files.js';
import * as hostBuildService from '../../server/src/services/host-builds.js';
import * as volumeService from '../../server/src/services/volumes.js';
import { resolveUserId } from './auth.js';
import { runSavedConnectionRead } from '../../server/src/databaseManagement.js';
import {
  getGithubWorkflowStatus,
  executeGithubAssistantReadOnlyTool,
  pullGithubRepoToBucket,
  pullGithubRepoToContainer,
  commitAndPushGithubFiles,
} from '../../server/src/githubAssistantTools.js';

type CallToolRequest = { params: { name: string; arguments?: Record<string, unknown> } };

function toResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function toError(err: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: (err as Error).message }) }],
    isError: true,
  };
}

export async function handleCallTool(request: CallToolRequest) {
  const { name, arguments: args = {} } = request.params;
  const userId = resolveUserId();

  try {
    let result: unknown;

    switch (name) {
      // ── Containers ─────────────────────────────────────────
      case 'list_containers':
        result = await containerService.list(userId, args.projectId as string | undefined);
        break;
      case 'launch_container':
        result = await containerService.launch(userId, args as any);
        break;
      case 'inspect_container':
        result = await containerService.inspect(args.id as string);
        break;
      case 'container_action':
        if (args.action === 'start') result = await containerService.start(args.id as string, userId);
        else if (args.action === 'stop') result = await containerService.stop(args.id as string, userId);
        else if (args.action === 'restart') result = await containerService.restart(args.id as string, userId);
        else throw new Error(`Unknown action: ${args.action}`);
        break;
      case 'delete_container':
        result = await containerService.remove(args.id as string, userId, args.force as boolean);
        break;
      case 'get_container_logs':
        result = await containerService.logs(args.id as string, args.tail as number | undefined);
        break;
      case 'update_container_env':
        result = await containerService.updateEnv(args.id as string, userId, args as any);
        break;
      case 'execute_container_command':
        result = await containerService.execCommand(args.id as string, userId, args as any);
        break;
      case 'get_container_exec_output':
        result = containerService.getExecOutput(args.execId as string);
        break;
      case 'write_container_file':
        result = await containerService.writeFile(args.id as string, userId, args as any);
        break;
      case 'write_container_files':
        result = await containerService.writeFiles(args.id as string, userId, args.files as any[]);
        break;
      case 'replace_in_container_file':
        result = await containerService.replaceInFile(args.id as string, userId, args as any);
        break;
      case 'list_container_files':
        result = await containerService.listContainerFiles(
          args.id as string,
          args.path as string | undefined,
          args.maxDepth as number | undefined,
        );
        break;
      case 'probe_container_endpoint':
        result = await containerService.probeContainerEndpoint(
          args.id as string,
          args.port as number,
          args.path as string | undefined,
          args.method as string | undefined,
        );
        break;

      // ── Buckets ─────────────────────────────────────────────
      case 'list_buckets':
        result = await bucketService.list(userId, args.projectId as string | undefined);
        break;
      case 'create_bucket':
        result = await bucketService.create(userId, args.name as string, args.protected as boolean | undefined);
        break;
      case 'delete_bucket':
        await bucketService.remove(args.name as string, userId);
        result = { ok: true };
        break;
      case 'update_bucket':
        bucketService.setProtected(args.name as string, !!args.protected);
        result = { name: args.name, protected: !!args.protected };
        break;
      case 'list_bucket_objects':
        result = await bucketService.listObjects(args.name as string, args.prefix as string | undefined);
        break;
      case 'read_bucket_object': {
        const obj = await bucketService.getObject(args.name as string, args.key as string);
        const chunks: Buffer[] = [];
        for await (const chunk of obj.body as AsyncIterable<Buffer>) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        result = { contentType: obj.contentType, body: Buffer.concat(chunks).toString('utf8') };
        break;
      }
      case 'write_bucket_object':
        await bucketService.putObject(
          args.name as string,
          args.key as string,
          Buffer.from(args.content as string || '', 'utf8'),
          args.contentType as string | undefined,
        );
        result = { ok: true, key: args.key };
        break;
      case 'write_bucket_objects': {
        const objs = (args.objects as any[] || []).map((o: any) => ({
          key: String(o.key),
          content: String(o.content),
          contentType: o.contentType as string | undefined,
        }));
        result = await bucketService.writeObjects(args.name as string, objs);
        break;
      }
      case 'delete_bucket_object':
        await bucketService.deleteObject(args.name as string, args.key as string);
        result = { ok: true };
        break;
      case 'replace_in_bucket_object':
        result = await bucketService.replaceInObject(
          args.name as string,
          args.key as string,
          args.search as string,
          args.replace as string,
        );
        break;

      // ── Gateway ─────────────────────────────────────────────
      case 'list_gateway_routes':
        result = gatewayService.list(userId, args.projectId as string | undefined);
        break;
      case 'create_gateway_route':
        result = gatewayService.createRoute(userId, args as any);
        break;
      case 'update_gateway_route':
        result = gatewayService.updateRoute(args.id as string, userId, args as any);
        break;
      case 'delete_gateway_route':
        gatewayService.deleteGatewayRoute(args.id as string, userId);
        result = { ok: true };
        break;
      case 'manage_gateway_domain':
        result = gatewayService.setDomain(args.id as string, userId, args.domain as string | null);
        break;
      case 'manage_dns_records': {
        if (args.action === 'create') {
          const res = await gatewayService.createDnsRecord(args.zoneId as string, args.name as string);
          result = { changeId: res.changeId, record: { name: args.name, type: 'CNAME' } };
        } else if (args.action === 'delete') {
          await gatewayService.deleteDnsRecord(args.zoneId as string, args.name as string);
          result = { ok: true };
        } else {
          throw new Error(`Unknown action: ${args.action}`);
        }
        break;
      }

      // ── Lambda ──────────────────────────────────────────────
      case 'list_functions':
        result = lambdaService.listFunctionsList(userId, args.projectId as string | undefined);
        break;
      case 'read_function':
        result = lambdaService.getFunc(args.id as string, userId);
        break;
      case 'create_lambda_function':
        result = lambdaService.createFunc(userId, args as any);
        break;
      case 'update_lambda_function':
        result = lambdaService.updateFunc(args.id as string, args as any);
        break;
      case 'delete_lambda_function':
        lambdaService.removeFunc(args.id as string);
        result = { ok: true };
        break;
      case 'run_lambda_function':
        result = await lambdaService.runCode(args as any);
        break;

      // ── Images ──────────────────────────────────────────────
      case 'list_images':
        result = await imageService.list();
        break;
      case 'delete_image':
        await imageService.remove(args.id as string, args.force as boolean);
        result = { ok: true };
        break;
      case 'prune_images':
        result = await imageService.prune();
        break;

      // ── System ──────────────────────────────────────────────
      case 'system_ping':
        result = await systemService.ping();
        break;
      case 'list_presets':
        result = systemService.presets();
        break;
      case 'list_used_ports':
        result = await systemService.usedPorts();
        break;
      case 'prune_build_cache':
        result = await systemService.pruneBuildCache();
        break;

      // ── Host ────────────────────────────────────────────────
      case 'list_host_directory':
        result = await hostFileService.listHostDirectory(args.sourcePath);
        break;
      case 'read_host_file':
        result = await hostFileService.readHostTextFile(args.sourcePath);
        break;
      case 'copy_host_file_to_container':
        result = await hostFileService.copyToContainer(
          args.sourcePath,
          args.id as string,
          args.path as string,
        );
        break;
      case 'copy_host_file_to_bucket':
        result = await hostFileService.copyToBucket(
          args.sourcePath,
          args.bucket as string,
          args.key as string,
          args.contentType as string | undefined,
        );
        break;

      // ── Host builds ─────────────────────────────────────────
      case 'list_host_build_presets':
        result = hostBuildService.listPresets();
        break;
      case 'run_host_build_preset':
        result = await hostBuildService.run(
          args.preset as string,
          args.id as string,
          args.path as string,
        );
        break;

      // ── Databases ───────────────────────────────────────────
      case 'list_database_connections':
        result = databaseService.listConnections(userId, args.projectId as string | undefined);
        break;
      case 'get_database_connection':
        result = databaseService.getConnection(args.id as string, userId);
        break;
      case 'get_database_operations_overview':
        result = databaseService.listOperations();
        break;
      case 'inspect_database_schema':
        result = await databaseService.inspectSchema(args.id as string, args.database);
        break;
      case 'run_database_read_query':
        result = await runSavedConnectionRead(String(args.connectionId ?? ''), args);
        break;
      case 'test_database_connection':
        result = await databaseService.testConnection(args.id as string);
        break;
      case 'create_database_connection':
        result = databaseService.createConnection(userId, args, args.projectId as string | undefined);
        break;
      case 'update_database_connection':
        result = databaseService.updateConnection(args.id as string, args);
        break;
      case 'delete_database_connection':
        databaseService.deleteConnection(args.id as string);
        result = { ok: true };
        break;
      case 'execute_database_mutation':
        result = await databaseService.executeMutation(String(args.connectionId ?? ''), args);
        break;
      case 'execute_database_migration':
        result = await databaseService.executeMigration(String(args.connectionId ?? ''), args);
        break;
      case 'execute_database_access_grant':
        result = await databaseService.executeGrant(String(args.connectionId ?? ''), args, userId);
        break;
      case 'create_database_backup':
        result = await databaseService.createBackup(String(args.connectionId ?? ''), args as any, userId);
        break;
      case 'restore_database_backup':
        result = await databaseService.restoreBackup(String(args.connectionId ?? ''), args as any, userId);
        break;
      case 'list_database_jobs':
        result = databaseService.listJobs(args.limit as number | undefined);
        break;
      case 'get_database_job':
        result = databaseService.getJob(args.id as string);
        break;

      // ── Projects ────────────────────────────────────────────
      case 'list_projects':
        result = projectService.list(userId);
        break;
      case 'create_project':
        result = projectService.create(userId || '', args as any);
        break;
      case 'update_project':
        result = projectService.update(args.id as string, userId || '', args as any);
        break;
      case 'delete_project':
        projectService.remove(args.id as string, userId);
        result = { ok: true };
        break;

      // ── Volumes ─────────────────────────────────────────────
      case 'list_volumes':
        result = await volumeService.list();
        break;

      // ── GitHub ──────────────────────────────────────────────
      case 'list_github_repo_files':
        result = await executeGithubAssistantReadOnlyTool(name, args);
        break;
      case 'read_github_file':
        result = await executeGithubAssistantReadOnlyTool(name, args);
        break;
      case 'pull_github_repo_to_bucket':
        result = await pullGithubRepoToBucket(args);
        break;
      case 'pull_github_repo_to_container':
        result = await pullGithubRepoToContainer(args);
        break;
      case 'commit_and_push_github_files':
        result = await commitAndPushGithubFiles(args);
        break;

      case 'get_github_workflow_status':
        result = await getGithubWorkflowStatus(args);
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return toResult(result);
  } catch (err) {
    return toError(err);
  }
}
