import { Router, type Request, type Response } from 'express';
import { HttpError } from '../services/HttpError.js';
import * as hostBuildService from '../services/host-builds.js';

export const hostBuildsRouter = Router();

// Re-export for backward compatibility.
export { listHostBuildPresets } from '../services/host-builds.js';

function sendError(res: Response, err: unknown): void {
  const status = err instanceof HttpError ? err.status : 502;
  res.status(status).json({ error: err instanceof Error ? err.message : 'Unknown error.' });
}

hostBuildsRouter.get('/presets', (_req: Request, res: Response) => {
  try {
    res.json(hostBuildService.listPresets());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

hostBuildsRouter.post('/run', async (req: Request, res: Response) => {
  const { preset: name, id, path: destinationPath } = req.body as Record<string, unknown>;
  try {
    res.json(await hostBuildService.run(
      name as string,
      id as string,
      destinationPath as string,
    ));
  } catch (err) {
    sendError(res, err);
  }
});
