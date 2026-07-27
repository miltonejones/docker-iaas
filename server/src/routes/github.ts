import { Router, type Request, type Response } from 'express';
import {
  commitAndPushGithubFiles,
  pullGithubRepoToBucket,
  pullGithubRepoToContainer,
} from '../githubAssistantTools.js';
import { getAuthUser, isWebhookAuthenticated } from '../auth.js';
import { recordAuditLog } from '../db/audit.js';

export const githubRouter = Router();

githubRouter.post('/pull-to-bucket', async (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId ?? (isWebhookAuthenticated(req) ? 'webhook' : null);
    recordAuditLog('github.pull_to_bucket', 'github', null, userId, (req.body as any)?.bucket);
    res.status(201).json(await pullGithubRepoToBucket(req.body as Record<string, unknown>));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

githubRouter.post('/pull-to-container', async (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId ?? (isWebhookAuthenticated(req) ? 'webhook' : null);
    recordAuditLog('github.pull_to_container', 'github', null, userId, (req.body as any)?.containerId);
    res.json(await pullGithubRepoToContainer(req.body as Record<string, unknown>));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

githubRouter.post('/commit-and-push', async (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId ?? (isWebhookAuthenticated(req) ? 'webhook' : null);
    recordAuditLog('github.commit_and_push', 'github', null, userId, (req.body as any)?.repo);
    res.json(await commitAndPushGithubFiles(req.body as Record<string, unknown>));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
