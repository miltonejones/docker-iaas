import { Router, type Request, type Response } from 'express';
import { HttpError } from '../services/HttpError.js';
import * as hostFileService from '../services/host-files.js';

export const hostFilesRouter = Router();

// Re-export for backward compatibility.
export {
  resolveHostPath,
  listHostDirectory,
  readHostTextFile,
  isSensitiveAssistantPath,
  validContainerPath,
  containsLikelySecret,
} from '../services/host-files.js';

function sendError(res: Response, err: unknown): void {
  const status = err instanceof HttpError ? err.status : 502;
  res.status(status).json({ error: err instanceof Error ? err.message : 'Unknown error.' });
}

hostFilesRouter.post('/to-bucket', async (req: Request, res: Response) => {
  const { sourcePath, bucket, key, contentType } = req.body as Record<string, unknown>;
  try {
    const result = await hostFileService.copyToBucket(
      sourcePath,
      bucket as string,
      key as string,
      contentType as string | undefined,
    );
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
});

hostFilesRouter.post('/to-container', async (req: Request, res: Response) => {
  const { sourcePath, id, path: destinationPath } = req.body as Record<string, unknown>;
  try {
    const result = await hostFileService.copyToContainer(
      sourcePath,
      id as string,
      destinationPath as string,
    );
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});
