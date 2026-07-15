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

export async function pingDocker(): Promise<DockerReachability> {
  try {
    const info = await docker.version();
    return { ok: true, version: info.Version };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
