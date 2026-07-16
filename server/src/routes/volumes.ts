import { Router, type Request, type Response } from 'express';
import { docker } from '../docker.js';

export const volumesRouter = Router();

volumesRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const data: any = await new Promise((resolve, reject) => {
      (docker as any).modem.dial(
        { method: 'GET', path: '/system/df', statusCodes: { 200: true } },
        (err: unknown, result: any) => (err ? reject(err) : resolve(result)),
      );
    });
    const volumes = (data?.Volumes || []).map((v: any) => ({
      name: v.Name || '',
      driver: v.Driver || '',
      mountpoint: v.Mountpoint || '',
      createdAt: v.CreatedAt || '',
      size: v.UsageData?.Size || 0,
      refCount: v.UsageData?.RefCount || 0,
    }));
    res.json(volumes);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
