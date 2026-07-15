import { Router, type Request, type Response } from 'express';
import { docker } from '../docker.js';

export const imagesRouter = Router();

imagesRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const list = await docker.listImages();
    res.json(
      list.map((img) => ({
        id: img.Id,
        tags: img.RepoTags || [],
        size: img.Size,
        created: img.Created,
      })),
    );
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

imagesRouter.delete('/:id', async (req: Request, res: Response) => {
  const force = req.query.force === 'true';
  try {
    await docker.getImage(req.params.id).remove({ force });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Prune reclaimable space (dangling images + stopped containers).
imagesRouter.post('/prune', async (_req: Request, res: Response) => {
  try {
    const [images, containers] = await Promise.all([
      docker.pruneImages(),
      docker.pruneContainers(),
    ]);
    const reclaimed = (images.SpaceReclaimed || 0) + (containers.SpaceReclaimed || 0);
    res.json({ ok: true, reclaimedBytes: reclaimed });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
