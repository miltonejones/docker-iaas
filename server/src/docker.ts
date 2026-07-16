import fs from 'node:fs';
import Docker from 'dockerode';

/**
 * Build a single shared Docker client.
 *
 * Connection is configurable so the same app can manage a local daemon
 * (default) or a remote Docker Engine over TCP:
 *
 *   - Local socket (default):  unset DOCKER_HOST, or point DOCKER_SOCKET at
 *     the unix socket (defaults to /var/run/docker.sock).
 *   - Remote TCP:              set DOCKER_HOST=tcp://<host>:2375  (or 2376 + TLS).
 *                              For TLS, set DOCKER_TLS_VERIFY=1 and DOCKER_CERT_PATH.
 */
function buildDocker(): Docker {
  const host = process.env.DOCKER_HOST;

  if (host && /^tcp:\/\//i.test(host)) {
    const url = new URL(host);
    const useTls = process.env.DOCKER_TLS_VERIFY === '1' || url.port === '2376';
    return new Docker({
      host: url.hostname,
      port: Number(url.port) || (useTls ? 2376 : 2375),
      protocol: useTls ? 'https' : 'http',
    });
  }

  const socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
  return new Docker({ socketPath });
}

export const docker = buildDocker();

export interface DockerReachability {
  ok: boolean;
  version?: string;
  error?: string;
}

const DOCKYARD_NET = 'dockyard-net';

/** Ensure the shared dockyard network exists so containers and lambda
 *  functions can address each other by container name. */
export async function ensureNetwork(): Promise<void> {
  const nets = await docker.listNetworks();
  if (nets.some((n) => n.Name === DOCKYARD_NET)) return;
  await docker.createNetwork({ Name: DOCKYARD_NET, Driver: 'bridge' });
}

/** NetworkingConfig fragment that attaches a container to the shared network. */
export function dockyardNetworkConfig(): { NetworkingConfig: { EndpointsConfig: Record<string, {}> } } {
  return {
    NetworkingConfig: {
      EndpointsConfig: {
        [DOCKYARD_NET]: {},
      },
    },
  };
}

/** Pull an image if it isn't present locally yet. */
export async function ensureImage(image: string): Promise<void> {
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

/** True when Dockyard's own server process is itself running inside a container. */
export function isSelfContainerized(): boolean {
  return fs.existsSync('/.dockerenv');
}

/** Hostname of a remote Docker Engine, if DOCKER_HOST points at one over TCP. */
export function remoteDockerHost(): string | null {
  const host = process.env.DOCKER_HOST;
  if (host && /^tcp:\/\//i.test(host)) return new URL(host).hostname;
  return null;
}

export async function pingDocker(): Promise<DockerReachability> {
  try {
    const info = await docker.version();
    return { ok: true, version: info.Version };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
