import { Router, type Request, type Response } from 'express';
import {
  commitAndPushGithubFiles,
  pullGithubRepoToBucket,
  pullGithubRepoToContainer,
} from '../githubAssistantTools.js';

export const githubRouter = Router();

githubRouter.post('/pull-to-bucket', async (req: Request, res: Response) => {
  try {
    res.status(201).json(await pullGithubRepoToBucket(req.body as Record<string, unknown>));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

githubRouter.post('/pull-to-container', async (req: Request, res: Response) => {
  try {
    res.json(await pullGithubRepoToContainer(req.body as Record<string, unknown>));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

githubRouter.post('/commit-and-push', async (req: Request, res: Response) => {
  try {
    res.json(await commitAndPushGithubFiles(req.body as Record<string, unknown>));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
