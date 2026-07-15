import { Router, type Request, type Response } from 'express';
import type Docker from 'dockerode';
import { docker, dockyardNetworkConfig } from '../docker.js';
import { findPreset } from '../presets.js';

export const containersRouter = Router();

interface ContainerView {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: number;
  ports: { privatePort: number; publicPort?: number; type: string }[];
  sizeRw: number;
  sizeRootFs: number;
  presetId?: string;
}

function toView(c: Docker.ContainerInfo): ContainerView {
  return {
    id: c.Id,
    name: (c.Names?.[0] || '').replace(/^\//, ''),
    image: c.Image,
    state: c.State,
    status: c.Status,
    created: c.Created,
    ports: (c.Ports || []).map((p) => ({
      privatePort: p.PrivatePort,
      publicPort: p.PublicPort,
      type: p.Type,
    })),
    sizeRw: (c as unknown as { SizeRw?: number }).SizeRw ?? 0,
    sizeRootFs: (c as unknown as { SizeRootFs?: number }).SizeRootFs ?? 0,
    presetId: c.Labels?.['iaas.preset'],
  };
}

// List all containers, including sizes (size=true) so the UI can show per-
// instance disk footprint next to the fleet-wide totals.
containersRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const list = await docker.listContainers({ all: true, size: true });
    res.json(list.map(toView));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

interface LaunchBody {
  presetId?: string;
  image?: string;
  name?: string;
  ports?: { container: string; host: number }[];
  env?: { key: string; value: string }[];
  volumes?: string[];
  autoStart?: boolean;
}

// Launch a new instance from a preset (or a raw image). Pulls the image if it
// is not present locally, creates the container, and starts it by default.
containersRouter.post('/', async (req: Request, res: Response) => {
  const body = req.body as LaunchBody;
  const preset = body.presetId ? findPreset(body.presetId) : undefined;
  const image = body.image || preset?.image;
  if (!image) {
    res.status(400).json({ error: 'An image or a valid presetId is required.' });
    return;
  }

  try {
    await ensureImage(image);

    const exposedPorts: Record<string, {}> = {};
    const portBindings: Record<string, { HostPort: string }[]> = {};
    for (const p of body.ports ?? []) {
      const key = p.container.includes('/') ? p.container : `${p.container}/tcp`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: String(p.host) }];
    }

    const env = (body.env ?? [])
      .filter((e) => e.key)
      .map((e) => `${e.key}=${e.value}`);

    // Build volume mounts from the preset (or explicit request).
    // Named volumes are created automatically by Docker and survive container
    // removal, so database data persists across recreate cycles.
    const volumePaths = body.volumes ?? preset?.volumes ?? [];
    const containerName = body.name || `${preset?.id ?? 'container'}-${Math.random().toString(36).slice(2, 8)}`;
    const mounts = volumePaths.length > 0
      ? volumePaths.map((dest) => {
          const slug = dest.replace(/^\//, '').replace(/\//g, '-');
          return {
            Type: 'volume' as const,
            Source: `iaas-${containerName}-${slug}`,
            Target: dest,
          };
        })
      : undefined;

    const container = await docker.createContainer({
      Image: image,
      name: body.name || undefined,
      Env: env.length ? env : undefined,
      ExposedPorts: Object.keys(exposedPorts).length ? exposedPorts : undefined,
      Labels: preset ? { 'iaas.preset': preset.id } : undefined,
      // Keep interactive OS/runtime images alive so they show as "running".
      Tty: preset ? ['ubuntu', 'debian', 'alpine', 'fedora', 'rockylinux', 'archlinux', 'node', 'python'].includes(preset.id) : false,
      HostConfig: {
        PortBindings: Object.keys(portBindings).length ? portBindings : undefined,
        RestartPolicy: { Name: 'unless-stopped' },
        Mounts: mounts,
      },
      ...dockyardNetworkConfig(),
    });

    if (body.autoStart !== false) {
      await container.start();
    }
    res.status(201).json({ id: container.id });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

async function ensureImage(image: string): Promise<void> {
  const tagged = image.includes(':') ? image : `${image}:latest`;
  const images = await docker.listImages();
  const present = images.some((img) => (img.RepoTags || []).includes(tagged));
  if (present) return;

  await new Promise<void>((resolve, reject) => {
    docker.pull(tagged, (err: unknown, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (doneErr: unknown) =>
        doneErr ? reject(doneErr) : resolve(),
      );
    });
  });
}

// Lifecycle actions -----------------------------------------------------------

async function lifecycle(
  id: string,
  action: 'start' | 'stop' | 'restart',
): Promise<void> {
  const c = docker.getContainer(id);
  if (action === 'start') await c.start();
  else if (action === 'stop') await c.stop();
  else await c.restart();
}

for (const action of ['start', 'stop', 'restart'] as const) {
  containersRouter.post(`/:id/${action}`, async (req: Request, res: Response) => {
    try {
      await lifecycle(req.params.id, action);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });
}

containersRouter.delete('/:id', async (req: Request, res: Response) => {
  const force = req.query.force === 'true';
  try {
    await docker.getContainer(req.params.id).remove({ force, v: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Full container detail (inspect) for the drill-down panel.
containersRouter.get('/:id/inspect', async (req: Request, res: Response) => {
  try {
    const data = await docker.getContainer(req.params.id).inspect();
    const detail = {
      id: data.Id,
      name: (data.Name || '').replace(/^\//, ''),
      image: data.Config?.Image ?? '',
      state: data.State?.Status ?? 'unknown',
      status: data.State?.Status ?? '',
      created: new Date(data.Created).getTime() / 1000,
      ports: (data.NetworkSettings?.Ports
        ? Object.entries(data.NetworkSettings.Ports).flatMap(([key, bindings]) => {
            const [port, proto] = key.split('/');
            return (bindings || []).map((b) => ({
              privatePort: Number(port),
              publicPort: b?.HostPort ? Number(b.HostPort) : undefined,
              type: proto || 'tcp',
            }));
          })
        : []),
      env: data.Config?.Env ?? [],
      volumes: (data.Mounts || []).map((m) => ({
        source: m.Source ?? '',
        destination: m.Destination ?? '',
        mode: m.Mode ?? '',
        type: m.Type ?? 'volume',
      })),
      restartPolicy: data.HostConfig?.RestartPolicy?.Name ?? 'no',
      labels: data.Config?.Labels ?? {},
      sizeRw: (data as unknown as { SizeRw?: number }).SizeRw ?? 0,
      sizeRootFs: (data as unknown as { SizeRootFs?: number }).SizeRootFs ?? 0,
    };
    res.json(detail);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

containersRouter.get('/:id/logs', async (req: Request, res: Response) => {
  try {
    const buf = await docker.getContainer(req.params.id).logs({
      stdout: true,
      stderr: true,
      tail: Number(req.query.tail ?? 200),
      timestamps: false,
    });
    res.type('text/plain').send(stripLogHeaders(buf as unknown as Buffer));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Non-TTY container logs are multiplexed with an 8-byte header per frame.
function stripLogHeaders(buf: Buffer): string {
  const out: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + len;
    if (end > buf.length) break;
    out.push(buf.subarray(start, end));
    offset = end;
  }
  if (out.length === 0) return buf.toString('utf8');
  return Buffer.concat(out).toString('utf8');
}
