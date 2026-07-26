import { Router, type Request, type Response } from 'express';
import { getAuthUser } from '../auth.js';
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
    res.json(listProjects(userId).map(toJson));
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

const RESOURCE_TABLES = ['functions', 'routes', 'bucket_owners', 'database_connections'] as const;

projectsRouter.put('/:id/resources', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }

    const project = getProject(req.params.id, userId);
    if (!project) { res.status(404).json({ error: 'Project not found.' }); return; }

    const { resourceTable, resourceId } = req.body as {
      resourceTable?: string;
      resourceId?: string;
    };

    if (!resourceTable || !RESOURCE_TABLES.includes(resourceTable as typeof RESOURCE_TABLES[number])) {
      res.status(400).json({ error: `resourceTable must be one of: ${RESOURCE_TABLES.join(', ')}.` });
      return;
    }
    if (!resourceId?.trim()) {
      res.status(400).json({ error: 'resourceId is required.' });
      return;
    }

    const idColumn = resourceTable === 'bucket_owners' ? 'bucket_name' : 'id';
    const result = setResourceProject(
      resourceTable as typeof RESOURCE_TABLES[number],
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

projectsRouter.delete('/:id/resources', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }

    const project = getProject(req.params.id, userId);
    if (!project) { res.status(404).json({ error: 'Project not found.' }); return; }

    // Read resource identifiers from query params (DELETE bodies may be stripped).
    const resourceTable = typeof req.query.resourceTable === 'string' ? req.query.resourceTable : null;
    const resourceId = typeof req.query.resourceId === 'string' ? req.query.resourceId.trim() : null;

    if (!resourceTable || !RESOURCE_TABLES.includes(resourceTable as typeof RESOURCE_TABLES[number])) {
      res.status(400).json({ error: `resourceTable must be one of: ${RESOURCE_TABLES.join(', ')}.` });
      return;
    }
    if (!resourceId) {
      res.status(400).json({ error: 'resourceId query parameter is required.' });
      return;
    }

    const idColumn = resourceTable === 'bucket_owners' ? 'bucket_name' : 'id';
    const result = setResourceProject(
      resourceTable as typeof RESOURCE_TABLES[number],
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
