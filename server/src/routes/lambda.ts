import { Router, type Request, type Response } from 'express';
import { getAuthUser, requireRole } from '../auth.js';
import { HttpError } from '../services/HttpError.js';
import * as lambdaService from '../services/lambda.js';
import { assertNotProtected } from '../services/projects.js';

export const lambdaRouter = Router();

// Re-export for backward compatibility with modules that import from this route file.
export { runLambda, entryPathOf, fullFileSet, splitLogStream as stripLogHeaders } from '../services/lambda.js';
export type { FunctionFile, RunResult } from '../services/lambda.js';

function sendError(res: Response, err: unknown): void {
  const status = err instanceof HttpError ? err.status : 500;
  res.status(status).json({ error: err instanceof Error ? err.message : 'Unknown error.' });
}

// List available runtimes.
lambdaRouter.get('/runtimes', (_req: Request, res: Response) => {
  res.json(lambdaService.listRuntimes());
});

// Execute code in a temporary container.
lambdaRouter.post('/run', requireRole('operator'), async (req: Request, res: Response) => {
  try {
    const result = await lambdaService.runCode(req.body);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

// Recent execution history.
lambdaRouter.get('/history', (_req: Request, res: Response) => {
  res.json(lambdaService.historyList());
});

// List all saved functions.
lambdaRouter.get('/functions', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const projectId = typeof req.query.projectId === 'string' && req.query.projectId.trim()
      ? req.query.projectId.trim()
      : undefined;
    res.json(lambdaService.listFunctionsList(userId, projectId));
  } catch (err) {
    sendError(res, err);
  }
});

// Get a single function.
lambdaRouter.get('/functions/:id', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    res.json(lambdaService.getFunc(req.params.id, userId));
  } catch (err) {
    sendError(res, err);
  }
});

// Create a new function.
lambdaRouter.post('/functions', requireRole('operator'), (req: Request, res: Response) => {
  try {
    const result = lambdaService.createFunc(getAuthUser(req)?.userId, req.body);
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
});

// Update an existing function.
lambdaRouter.put('/functions/:id', requireRole('operator'), (req: Request, res: Response) => {
  try {
    res.json(lambdaService.updateFunc(req.params.id, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

// Delete a function.
lambdaRouter.delete('/functions/:id', requireRole('operator'), (req: Request, res: Response) => {
  try {
    assertNotProtected('functions', req.params.id, req.authUser?.role);
    lambdaService.removeFunc(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// Get function env vars.
lambdaRouter.get('/functions/:id/env', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    res.json(lambdaService.getFuncEnv(req.params.id, userId));
  } catch (err) {
    sendError(res, err);
  }
});

// Set function env vars.
lambdaRouter.put('/functions/:id/env', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const { env } = req.body as { env?: Record<string, string> };
    res.json(lambdaService.setFuncEnv(req.params.id, userId, env || {}));
  } catch (err) {
    sendError(res, err);
  }
});
