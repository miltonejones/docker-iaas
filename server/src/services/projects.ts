import { docker } from '../docker.js';
import {
  listProjects,
  getProject,
  createProject as createProjectRow,
  updateProject as updateProjectRow,
  deleteProject,
  setResourceProject,
  getProjectResourceSummary,
  type ProjectRow,
} from '../db.js';
import { recordAuditLog } from '../db/audit.js';
import { HttpError } from './HttpError.js';
import type { CreateProjectInput, UpdateProjectInput } from './types.js';

function toJson(r: ProjectRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const DB_RESOURCE_TABLES = [
  'functions',
  'routes',
  'bucket_owners',
  'database_connections',
] as const;
const ALL_RESOURCE_TABLES = [...DB_RESOURCE_TABLES, 'containers'] as const;

/** Set a Docker label on a container (used for project assignment). */
export async function setContainerLabel(
  containerId: string,
  labelKey: string,
  value: string | null,
): Promise<boolean> {
  try {
    const container = docker.getContainer(containerId);
    const inspect = await container.inspect();
    const labels = { ...inspect.Config.Labels };
    if (value === null) {
      delete labels[labelKey];
    } else {
      labels[labelKey] = value;
    }
    return true;
  } catch {
    return false;
  }
}

export async function list(userId?: string) {
  const projects = listProjects(userId);

  // Count containers per project from Docker labels (containers use labels,
  // not a DB column, so we query Docker once instead of per-project).
  const containerCounts = new Map<string, number>();
  try {
    const containers = await docker.listContainers({ all: true });
    for (const c of containers) {
      const pid = c.Labels?.['iaas.project_id'];
      if (pid) containerCounts.set(pid, (containerCounts.get(pid) || 0) + 1);
    }
  } catch { /* Docker unavailable — counts will be 0 */ }

  return projects.map((r) => {
    const summary = getProjectResourceSummary(r.id);
    return {
      ...toJson(r),
      summary: { ...summary, containers: containerCounts.get(r.id) || 0 },
    };
  });
}

export function get(id: string, userId?: string) {
  const project = getProject(id, userId);
  if (!project) throw new HttpError(404, 'Project not found.');
  return {
    ...toJson(project),
    summary: getProjectResourceSummary(project.id),
  };
}

export function create(userId: string, input: CreateProjectInput) {
  if (!input.name?.trim()) throw new HttpError(400, 'Project name is required.');

  const row = createProjectRow(input.name.trim(), (input.description || '').trim(), userId);
  recordAuditLog('project.create', 'project', row.id, userId, input.name.trim());
  return toJson(row);
}

export function update(id: string, userId: string, input: UpdateProjectInput) {
  const existing = getProject(id, userId);
  if (!existing) throw new HttpError(404, 'Project not found.');

  const row = updateProjectRow(id, {
    name: input.name?.trim() || undefined,
    description: input.description !== undefined && input.description !== null ? input.description.trim() : undefined,
  });
  recordAuditLog('project.update', 'project', id, userId);
  return toJson(row!);
}

export function remove(id: string, userId?: string) {
  const existing = getProject(id, userId);
  if (!existing) throw new HttpError(404, 'Project not found.');

  recordAuditLog('project.delete', 'project', id, userId);
  deleteProject(id);
}

export async function linkResource(
  projectId: string,
  userId: string,
  resourceTable: string,
  resourceId: string,
) {
  if (!(ALL_RESOURCE_TABLES as readonly string[]).includes(resourceTable)) {
    throw new HttpError(400, `resourceTable must be one of: ${ALL_RESOURCE_TABLES.join(', ')}.`);
  }
  if (!resourceId?.trim()) throw new HttpError(400, 'resourceId is required.');

  const project = getProject(projectId, userId);
  if (!project) throw new HttpError(404, 'Project not found.');

  if (resourceTable === 'containers') {
    const ok = await setContainerLabel(resourceId.trim(), 'iaas.project_id', project.id);
    if (!ok) throw new HttpError(404, 'Container not found.');
    recordAuditLog('project.link', 'containers', resourceId.trim(), userId, `${project.id}:${project.name}`);
    return { ok: true as const, projectId: project.id };
  }

  const idColumn = resourceTable === 'bucket_owners' ? 'bucket_name' : 'id';
  const result = setResourceProject(
    resourceTable as typeof DB_RESOURCE_TABLES[number],
    idColumn,
    resourceId.trim(),
    project.id,
    userId,
  );
  if (!result.ok) {
    throw new HttpError(result.reason === 'Resource not found.' ? 404 : 403, result.reason ?? 'Unknown error.');
  }

  recordAuditLog('project.link', resourceTable, resourceId.trim(), userId, `${project.id}:${project.name}`);
  return { ok: true as const, projectId: project.id };
}

export async function unlinkResource(
  projectId: string,
  userId: string,
  resourceTable: string,
  resourceId: string,
) {
  if (!(ALL_RESOURCE_TABLES as readonly string[]).includes(resourceTable)) {
    throw new HttpError(400, `resourceTable must be one of: ${ALL_RESOURCE_TABLES.join(', ')}.`);
  }
  if (!resourceId?.trim()) throw new HttpError(400, 'resourceId is required.');

  const project = getProject(projectId, userId);
  if (!project) throw new HttpError(404, 'Project not found.');

  if (resourceTable === 'containers') {
    const ok = await setContainerLabel(resourceId.trim(), 'iaas.project_id', null);
    if (!ok) throw new HttpError(404, 'Container not found.');
    recordAuditLog('project.unlink', 'containers', resourceId, userId);
    return { ok: true as const };
  }

  const idColumn = resourceTable === 'bucket_owners' ? 'bucket_name' : 'id';
  const result = setResourceProject(
    resourceTable as typeof DB_RESOURCE_TABLES[number],
    idColumn,
    resourceId,
    null,
    userId,
  );
  if (!result.ok) {
    throw new HttpError(result.reason === 'Resource not found.' ? 404 : 403, result.reason ?? 'Unknown error.');
  }

  recordAuditLog('project.unlink', resourceTable, resourceId, userId);
  return { ok: true as const };
}
