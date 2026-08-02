import { docker } from '../docker.js';
import {
  listProjects,
  getProject,
  createProject as createProjectRow,
  updateProject as updateProjectRow,
  deleteProject,
  setResourceProject,
  getProjectResourceSummary,
  updateProjectManifest,
  listProjectsWithManifest,
  listFunctions,
  type ProjectRow,
} from '../db.js';
import { listRoutes } from '../db/gateway.js';
import { listConnectionDetails } from '../databaseManagement.js';
import * as containerService from './containers.js';
import * as bucketService from './buckets.js';
import { recordAuditLog } from '../db/audit.js';
import { HttpError } from './HttpError.js';
import type {
  CreateProjectInput,
  UpdateProjectInput,
  ProjectManifest,
  ProjectManifestResource,
  ManifestSection,
  ManifestDrift,
} from './types.js';

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
    stripFromManifest(project.id, resourceTable, resourceId.trim());
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
  stripFromManifest(project.id, resourceTable, resourceId);
  return { ok: true as const };
}

// ── Manifest — capture-only snapshot + drift + protection ─────────────

const TABLE_TO_SECTION: Record<string, ManifestSection> = {
  containers: 'containers',
  routes: 'routes',
  functions: 'functions',
  bucket_owners: 'buckets',
  database_connections: 'databases',
};

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'resource';
}

function uniqueRef(base: string, used: Set<string>): string {
  let ref = base;
  let n = 2;
  while (used.has(ref)) { ref = `${base}-${n}`; n += 1; }
  used.add(ref);
  return ref;
}

function parseManifest(raw: string): ProjectManifest | null {
  try { return JSON.parse(raw) as ProjectManifest; } catch { return null; }
}

function envArrayToRecord(env: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of env) {
    const idx = e.indexOf('=');
    if (idx > 0) out[e.slice(0, idx)] = e.slice(idx + 1);
  }
  return out;
}

/** Containers linked to a project, tolerating an unreachable Docker daemon
 *  (matches the defensive pattern used in list() above). */
async function listProjectContainers(projectId: string) {
  try {
    return await containerService.list(undefined, projectId);
  } catch {
    return [];
  }
}

/** Buckets linked to a project, tolerating an unreachable MinIO instance. */
async function listProjectBuckets(projectId: string) {
  try {
    return await bucketService.list(undefined, projectId);
  } catch {
    return [];
  }
}

/** Capture a snapshot of every resource currently linked to a project. */
export async function captureManifest(projectId: string, userId?: string): Promise<ProjectManifest> {
  const project = getProject(projectId, userId);
  if (!project) throw new HttpError(404, 'Project not found.');

  const manifest: ProjectManifest = {
    version: 1,
    capturedAt: new Date().toISOString(),
    containers: {},
    routes: {},
    functions: {},
    buckets: {},
    databases: {},
  };

  const containerRefById = new Map<string, string>();
  const containerRefs = new Set<string>();
  const containers = await listProjectContainers(projectId);
  for (const c of containers) {
    const ref = uniqueRef(slugify(c.name), containerRefs);
    containerRefById.set(c.id, ref);
    let image = c.image;
    let env: Record<string, string> = {};
    let ports: ProjectManifestResource['ports'] = (c.ports || []).map((p) => ({
      container: String(p.privatePort),
      host: p.publicPort ?? null,
    }));
    try {
      const detail = await containerService.inspect(c.id);
      image = detail.image;
      env = envArrayToRecord(detail.env);
      ports = detail.ports.map((p) => ({ container: String(p.privatePort), host: p.publicPort ?? null }));
    } catch { /* container vanished between list and inspect — keep the list-derived snapshot */ }
    manifest.containers[ref] = { id: c.id, image, ports, env, description: c.description };
  }

  const functionRefs = new Set<string>();
  for (const f of listFunctions(undefined, projectId)) {
    const ref = uniqueRef(slugify(f.name), functionRefs);
    manifest.functions[ref] = { id: f.id, runtime: f.runtime };
  }

  const bucketRefs = new Set<string>();
  for (const b of await listProjectBuckets(projectId)) {
    const ref = uniqueRef(slugify(b.name!), bucketRefs);
    manifest.buckets[ref] = { id: b.name! };
  }

  const databaseRefs = new Set<string>();
  for (const d of listConnectionDetails(undefined, projectId)) {
    const ref = uniqueRef(slugify(d.name), databaseRefs);
    manifest.databases[ref] = { id: d.id, engine: d.engine };
  }

  const routeRefs = new Set<string>();
  for (const r of listRoutes(undefined, projectId)) {
    const ref = uniqueRef(slugify(r.name), routeRefs);
    const targetRef = r.target_type === 'container' ? containerRefById.get(r.target_id) : undefined;
    manifest.routes[ref] = {
      id: r.id,
      targetType: r.target_type as ProjectManifestResource['targetType'],
      targetRef: targetRef ?? r.target_id,
      targetPort: r.target_port,
      method: r.method,
      pathPattern: r.path_pattern,
      domain: r.domain,
    };
  }

  updateProjectManifest(project.id, JSON.stringify(manifest));
  recordAuditLog('project.manifest.capture', 'project', project.id, userId);
  return manifest;
}

export function getManifest(projectId: string, userId?: string): ProjectManifest {
  const project = getProject(projectId, userId);
  if (!project) throw new HttpError(404, 'Project not found.');
  if (!project.manifest) throw new HttpError(404, 'No manifest captured yet.');
  const manifest = parseManifest(project.manifest);
  if (!manifest) throw new HttpError(500, 'Stored manifest is corrupt.');
  return manifest;
}

/** Compare the stored manifest against live resource state. */
export async function getManifestDrift(projectId: string, userId?: string): Promise<ManifestDrift> {
  const manifest = getManifest(projectId, userId);
  const drift: ManifestDrift = { synced: [], missing: [], changed: [], orphaned: [] };

  function record(ref: string, kind: ManifestSection, diff: Record<string, unknown>) {
    if (Object.keys(diff).length) drift.changed.push({ ref, kind, diff });
    else drift.synced.push(ref);
  }

  // Containers
  const liveContainers = await listProjectContainers(projectId);
  const liveContainerById = new Map(liveContainers.map((c) => [c.id, c]));
  for (const [ref, snap] of Object.entries(manifest.containers)) {
    const live = liveContainerById.get(snap.id);
    if (!live) { drift.missing.push({ ref, kind: 'containers' }); continue; }
    liveContainerById.delete(snap.id);
    const diff: Record<string, unknown> = {};
    if (live.image !== snap.image) diff.image = { was: snap.image, now: live.image };
    try {
      const detail = await containerService.inspect(live.id);
      const liveEnv = envArrayToRecord(detail.env);
      if (JSON.stringify(liveEnv) !== JSON.stringify(snap.env || {})) {
        diff.env = { was: snap.env || {}, now: liveEnv };
      }
    } catch { /* container vanished mid-comparison — image diff (if any) still applies */ }
    record(ref, 'containers', diff);
  }
  for (const [id] of liveContainerById) drift.orphaned.push({ ref: id, kind: 'containers', id });

  // Functions
  const liveFunctions = listFunctions(undefined, projectId);
  const liveFnById = new Map(liveFunctions.map((f) => [f.id, f]));
  for (const [ref, snap] of Object.entries(manifest.functions)) {
    const live = liveFnById.get(snap.id);
    if (!live) { drift.missing.push({ ref, kind: 'functions' }); continue; }
    liveFnById.delete(snap.id);
    const diff: Record<string, unknown> = {};
    if (live.runtime !== snap.runtime) diff.runtime = { was: snap.runtime, now: live.runtime };
    record(ref, 'functions', diff);
  }
  for (const [id] of liveFnById) drift.orphaned.push({ ref: id, kind: 'functions', id });

  // Buckets — existence only; there's no captured config beyond membership.
  const liveBuckets = await listProjectBuckets(projectId);
  const liveBucketByName = new Map(liveBuckets.map((b) => [b.name!, b]));
  for (const [ref, snap] of Object.entries(manifest.buckets)) {
    if (!liveBucketByName.has(snap.id)) { drift.missing.push({ ref, kind: 'buckets' }); continue; }
    liveBucketByName.delete(snap.id);
    drift.synced.push(ref);
  }
  for (const [name] of liveBucketByName) drift.orphaned.push({ ref: name, kind: 'buckets', id: name });

  // Databases
  const liveDbs = listConnectionDetails(undefined, projectId);
  const liveDbById = new Map(liveDbs.map((d) => [d.id, d]));
  for (const [ref, snap] of Object.entries(manifest.databases)) {
    const live = liveDbById.get(snap.id);
    if (!live) { drift.missing.push({ ref, kind: 'databases' }); continue; }
    liveDbById.delete(snap.id);
    const diff: Record<string, unknown> = {};
    if (live.engine !== snap.engine) diff.engine = { was: snap.engine, now: live.engine };
    record(ref, 'databases', diff);
  }
  for (const [id] of liveDbById) drift.orphaned.push({ ref: id, kind: 'databases', id });

  // Routes — target comparison resolves the manifest's logical targetRef back
  // to the container id it pointed at during capture (targetRef survives
  // container recreation; the raw target_id on the live route may not).
  const liveRoutes = listRoutes(undefined, projectId);
  const liveRouteById = new Map(liveRoutes.map((r) => [r.id, r]));
  for (const [ref, snap] of Object.entries(manifest.routes)) {
    const live = liveRouteById.get(snap.id);
    if (!live) { drift.missing.push({ ref, kind: 'routes' }); continue; }
    liveRouteById.delete(snap.id);
    const diff: Record<string, unknown> = {};
    if (live.target_type !== snap.targetType) diff.targetType = { was: snap.targetType, now: live.target_type };
    const expectedTargetId = snap.targetType === 'container'
      ? manifest.containers[snap.targetRef || '']?.id ?? snap.targetRef
      : snap.targetRef;
    if (live.target_id !== expectedTargetId) diff.target = { was: snap.targetRef, now: live.target_id };
    if ((live.target_port ?? null) !== (snap.targetPort ?? null)) {
      diff.targetPort = { was: snap.targetPort ?? null, now: live.target_port ?? null };
    }
    if ((live.path_pattern || null) !== (snap.pathPattern || null)) {
      diff.pathPattern = { was: snap.pathPattern || null, now: live.path_pattern || null };
    }
    if ((live.domain || null) !== (snap.domain || null)) {
      diff.domain = { was: snap.domain || null, now: live.domain || null };
    }
    record(ref, 'routes', diff);
  }
  for (const [id] of liveRouteById) drift.orphaned.push({ ref: id, kind: 'routes', id });

  return drift;
}

/** Checks whether a resource is referenced in ANY project's manifest.
 *  Used to hard-block delete/target-change actions for non-admin users. */
export function isResourceProtected(
  resourceType: ManifestSection,
  resourceId: string,
): { protected: boolean; projectName?: string } {
  for (const row of listProjectsWithManifest()) {
    const manifest = parseManifest(row.manifest);
    if (!manifest) continue;
    const section = manifest[resourceType];
    if (!section) continue;
    for (const snap of Object.values(section)) {
      if (snap.id === resourceId) return { protected: true, projectName: row.name };
    }
  }
  return { protected: false };
}

const RESOURCE_LABEL: Record<ManifestSection, string> = {
  containers: 'Container',
  routes: 'Route',
  functions: 'Function',
  buckets: 'Bucket',
  databases: 'Database connection',
};

/** Throws a 409 if the resource is referenced by a project manifest, unless
 *  the caller has the admin role (admins bypass all manifest protection). */
export function assertNotProtected(resourceType: ManifestSection, resourceId: string, role: string | undefined): void {
  if (role === 'admin') return;
  const check = isResourceProtected(resourceType, resourceId);
  if (check.protected) {
    throw new HttpError(
      409,
      `${RESOURCE_LABEL[resourceType]} is managed by project "${check.projectName}". Unlink it from the project first.`,
    );
  }
}

/** Remove a resource's entry from a project's manifest (called on unlink so
 *  the manifest doesn't keep referencing resources that left the project). */
function stripFromManifest(projectId: string, resourceTable: string, resourceId: string): void {
  const section = TABLE_TO_SECTION[resourceTable];
  if (!section) return;

  const project = getProject(projectId);
  if (!project?.manifest) return;
  const manifest = parseManifest(project.manifest);
  if (!manifest) return;

  let changed = false;
  for (const [ref, snap] of Object.entries(manifest[section])) {
    if (snap.id === resourceId) {
      delete manifest[section][ref];
      changed = true;
    }
  }
  if (changed) updateProjectManifest(projectId, JSON.stringify(manifest));
}
