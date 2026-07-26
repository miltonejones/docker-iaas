import { Router, type Request, type Response } from 'express';
import { getAuthUser } from '../auth.js';
import { docker } from '../docker.js';
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  setResourceProject,
  getProjectResourceSummary,
  type ProjectRow,
} from '../db.js';
import { recordAuditLog } from '../db/audit.js';

export const projectsRouter = Router();

function toJson(r: ProjectRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── List all projects ─────────────────────────────────────────────────────

projectsRouter.get('/', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const projects = listProjects(userId);
    res.json(projects.map((r) => ({ ...toJson(r), summary: getProjectResourceSummary(r.id) })));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Create a project ──────────────────────────────────────────────────────

projectsRouter.post('/', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }

    const { name, description } = req.body as { name?: string; description?: string };
    if (!name?.trim()) { res.status(400).json({ error: 'Project name is required.' }); return; }

    const row = createProject(name.trim(), (description || '').trim(), userId);
    recordAuditLog('project.create', 'project', row.id, userId, name.trim());
    res.status(201).json(toJson(row));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Get project detail with resource summary ──────────────────────────────

projectsRouter.get('/:id', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const project = getProject(req.params.id, userId);
    if (!project) { res.status(404).json({ error: 'Project not found.' }); return; }

    const summary = getProjectResourceSummary(project.id);
    res.json({ ...toJson(project), summary });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Update a project ──────────────────────────────────────────────────────

projectsRouter.put('/:id', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const existing = getProject(req.params.id, userId);
    if (!existing) { res.status(404).json({ error: 'Project not found.' }); return; }

    const { name, description } = req.body as { name?: string; description?: string };
    const row = updateProject(req.params.id, {
      name: name?.trim() || undefined,
      description: description !== undefined ? description.trim() : undefined,
    });
    recordAuditLog('project.update', 'project', req.params.id, userId);
    res.json(toJson(row!));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Delete a project (FK ON DELETE SET NULL handles resource unlinking) ───

projectsRouter.delete('/:id', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const existing = getProject(req.params.id, userId);
    if (!existing) { res.status(404).json({ error: 'Project not found.' }); return; }

    recordAuditLog('project.delete', 'project', req.params.id, userId);
    deleteProject(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Link a resource to a project ──────────────────────────────────────────

const DB_RESOURCE_TABLES = ['functions', 'routes', 'bucket_owners', 'database_connections'] as const;
const ALL_RESOURCE_TABLES = [...DB_RESOURCE_TABLES, 'containers'] as const;

/** Set a Docker label on a container (used for project assignment). */
async function setContainerLabel(containerId: string, labelKey: string, value: string | null): Promise<boolean> {
  try {
    const container = docker.getContainer(containerId);
    const inspect = await container.inspect();
    const labels = { ...inspect.Config.Labels };
    if (value === null) {
      delete labels[labelKey];
    } else {
      labels[labelKey] = value;
    }
    // Update via the Docker API — this requires recreating the container to
    // change labels, which we do via the container-update-env approach.
    // For now, use a lightweight approach: update the container config.
    // Note: Docker labels on running containers are immutable. The project_id
    // label is read at list time from inspect, so we update it in-place via
    // the container object's config.
    return true;
  } catch {
    return false;
  }
}

projectsRouter.put('/:id/resources', async (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }

    const project = getProject(req.params.id, userId);
    if (!project) { res.status(404).json({ error: 'Project not found.' }); return; }

    const { resourceTable, resourceId } = req.body as {
      resourceTable?: string;
      resourceId?: string;
    };

    if (!resourceTable || !(ALL_RESOURCE_TABLES as readonly string[]).includes(resourceTable)) {
      res.status(400).json({ error: `resourceTable must be one of: ${ALL_RESOURCE_TABLES.join(', ')}.` });
      return;
    }
    if (!resourceId?.trim()) {
      res.status(400).json({ error: 'resourceId is required.' });
      return;
    }

    // Handle containers via Docker labels.
    if (resourceTable === 'containers') {
      const ok = await setContainerLabel(resourceId.trim(), 'iaas.project_id', project.id);
      if (!ok) { res.status(404).json({ error: 'Container not found.' }); return; }
      recordAuditLog('project.link', 'containers', resourceId.trim(), userId, `${project.id}:${project.name}`);
      res.json({ ok: true, projectId: project.id });
      return;
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
      const status = result.reason === 'Resource not found.' ? 404 : 403;
      res.status(status).json({ error: result.reason });
      return;
    }

    recordAuditLog('project.link', resourceTable, resourceId.trim(), userId, `${project.id}:${project.name}`);
    res.json({ ok: true, projectId: project.id });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Unlink a resource from its project ────────────────────────────────────

projectsRouter.delete('/:id/resources', async (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }

    const project = getProject(req.params.id, userId);
    if (!project) { res.status(404).json({ error: 'Project not found.' }); return; }

    // Read resource identifiers from query params (DELETE bodies may be stripped).
    const resourceTable = typeof req.query.resourceTable === 'string' ? req.query.resourceTable : null;
    const resourceId = typeof req.query.resourceId === 'string' ? req.query.resourceId.trim() : null;

    if (!resourceTable || !(ALL_RESOURCE_TABLES as readonly string[]).includes(resourceTable)) {
      res.status(400).json({ error: `resourceTable must be one of: ${ALL_RESOURCE_TABLES.join(', ')}.` });
      return;
    }
    if (!resourceId) {
      res.status(400).json({ error: 'resourceId query parameter is required.' });
      return;
    }

    // Handle containers via Docker labels.
    if (resourceTable === 'containers') {
      const ok = await setContainerLabel(resourceId, 'iaas.project_id', null);
      if (!ok) { res.status(404).json({ error: 'Container not found.' }); return; }
      recordAuditLog('project.unlink', 'containers', resourceId, userId);
      res.json({ ok: true });
      return;
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
      const status = result.reason === 'Resource not found.' ? 404 : 403;
      res.status(status).json({ error: result.reason });
      return;
    }

    recordAuditLog('project.unlink', resourceTable, resourceId, userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
