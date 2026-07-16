import { Router, type Request, type Response } from 'express';
import { listRoutes, getRoutesByName, createRoute, deleteRoute } from '../db.js';

export const gatewayRouter = Router();

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const TARGET_TYPES = new Set(['bucket', 'container', 'lambda']);
const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

function toJson(r: import('../db.js').RouteRow) {
  return {
    id: r.id,
    name: r.name,
    targetType: r.target_type,
    targetId: r.target_id,
    targetPort: r.target_port,
    method: r.method || null,
    pathPattern: r.path_pattern || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

gatewayRouter.get('/', (_req: Request, res: Response) => {
  try {
    res.json(listRoutes().map(toJson));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

gatewayRouter.post('/', (req: Request, res: Response) => {
  try {
    const { name, targetType, targetId, targetPort, method, pathPattern } = req.body as {
      name?: string;
      targetType?: string;
      targetId?: string;
      targetPort?: number;
      method?: string;
      pathPattern?: string;
    };

    if (!name || !NAME_RE.test(name)) {
      res.status(400).json({ error: 'Name must be lowercase letters, digits, and hyphens, starting with a letter or digit.' });
      return;
    }
    if (!targetType || !TARGET_TYPES.has(targetType)) {
      res.status(400).json({ error: `targetType must be one of: ${Array.from(TARGET_TYPES).join(', ')}.` });
      return;
    }
    if (!targetId?.trim()) {
      res.status(400).json({ error: 'A targetId is required.' });
      return;
    }
    if (targetType === 'container' && !targetPort) {
      res.status(400).json({ error: 'A targetPort is required for container routes.' });
      return;
    }

    const methodNorm = method?.trim().toUpperCase() || null;
    if (methodNorm && !VALID_METHODS.has(methodNorm)) {
      res.status(400).json({ error: `Invalid method. Must be one of: ${Array.from(VALID_METHODS).join(', ')}.` });
      return;
    }

    const pathNorm = pathPattern?.trim() || null;
    if (pathNorm && !pathNorm.startsWith('/')) {
      res.status(400).json({ error: 'pathPattern must start with "/".' });
      return;
    }

    // Check for duplicate: same name + same method + same path.
    const existing = getRoutesByName(name);
    const dup = existing.find(
      (r) => (r.method || null) === methodNorm && (r.path_pattern || null) === pathNorm,
    );
    if (dup) {
      const desc = [name, methodNorm, pathNorm].filter(Boolean).join(' ');
      res.status(409).json({ error: `A route matching "${desc}" already exists.` });
      return;
    }

    const id = `rt-${Math.random().toString(36).slice(2, 8)}`;
    const row = createRoute(
      id,
      name,
      targetType,
      targetId.trim(),
      targetType === 'container' ? Number(targetPort) : null,
      methodNorm,
      pathNorm,
    );
    res.status(201).json(toJson(row));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

gatewayRouter.delete('/:id', (req: Request, res: Response) => {
  try {
    const deleted = deleteRoute(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Route not found.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
