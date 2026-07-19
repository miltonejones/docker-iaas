import crypto from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { docker, dockyardNetworkConfig, ensureImage, isSelfContainerized, remoteDockerHost } from './docker.js';
import { getSetting, setSetting } from './db.js';

const CONTAINER_NAME = 'dockyard-minio';
const IMAGE = 'minio/minio:latest';
const S3_PORT = 9000;
const CONSOLE_PORT = 9001;

function getOrCreateCredentials(): { accessKey: string; secretKey: string } {
  let accessKey = getSetting('minio_root_user');
  let secretKey = getSetting('minio_root_password');
  if (!accessKey || !secretKey) {
    accessKey = 'dockyard';
    secretKey = crypto.randomBytes(24).toString('base64url');
    setSetting('minio_root_user', accessKey);
    setSetting('minio_root_password', secretKey);
  }
  return { accessKey, secretKey };
}

/** Ensure the persistent MinIO instance exists and is running. Idempotent. */
export async function ensureMinio(): Promise<void> {
  const { accessKey, secretKey } = getOrCreateCredentials();

  const existing = await docker.listContainers({ all: true, filters: { name: [CONTAINER_NAME] } });
  if (existing.length > 0) {
    // Sync SQLite credentials to the running container's env so the S3
    // client doesn't produce a signature mismatch when the SQLite db was
    // recreated or migrated separately from the MinIO data volume.
    const info = await docker.getContainer(existing[0].Id).inspect();
    const env = info.Config?.Env || [];
    const containerUser = env.find((e) => e.startsWith('MINIO_ROOT_USER='))?.split('=')[1];
    const containerPass = env.find((e) => e.startsWith('MINIO_ROOT_PASSWORD='))?.split('=')[1];
    if (containerUser && containerPass) {
      if (containerUser !== accessKey) setSetting('minio_root_user', containerUser);
      if (containerPass !== secretKey) setSetting('minio_root_password', containerPass);
    }
    if (existing[0].State !== 'running') {
      await docker.getContainer(existing[0].Id).start();
    }
    return;
  }

  await ensureImage(IMAGE);

  const container = await docker.createContainer({
    Image: IMAGE,
    name: CONTAINER_NAME,
    Env: [`MINIO_ROOT_USER=${accessKey}`, `MINIO_ROOT_PASSWORD=${secretKey}`],
    Cmd: ['server', '/data', '--console-address', `:${CONSOLE_PORT}`],
    Labels: { 'iaas.system': 'minio' },
    ExposedPorts: {
      [`${S3_PORT}/tcp`]: {},
      [`${CONSOLE_PORT}/tcp`]: {},
    },
    HostConfig: {
      PortBindings: {
        [`${S3_PORT}/tcp`]: [{ HostPort: String(S3_PORT) }],
        [`${CONSOLE_PORT}/tcp`]: [{ HostPort: String(CONSOLE_PORT) }],
      },
      RestartPolicy: { Name: 'unless-stopped' },
      Mounts: [{ Type: 'volume', Source: 'iaas-minio-data', Target: '/data' }],
    },
    ...dockyardNetworkConfig(),
  });

  await container.start();
}

/** Resolve the S3 API base URL reachable from this Node process. */
export function minioEndpoint(): string {
  if (process.env.MINIO_ENDPOINT) return process.env.MINIO_ENDPOINT;

  // Dockyard's own server is containerized — reach MinIO by name on dockyard-net.
  if (isSelfContainerized()) return `http://${CONTAINER_NAME}:${S3_PORT}`;

  // Managing a remote Docker Engine over TCP — MinIO's published port lives there too.
  const remoteHost = remoteDockerHost();
  if (remoteHost) return `http://${remoteHost}:${S3_PORT}`;

  // Local dev — server runs directly on the host alongside the local Docker daemon.
  return `http://127.0.0.1:${S3_PORT}`;
}

let s3Client: S3Client | undefined;

/** Lazily build the shared S3 client, once credentials exist. */
export function getS3Client(): S3Client {
  if (s3Client) return s3Client;
  const { accessKey, secretKey } = getOrCreateCredentials();
  s3Client = new S3Client({
    endpoint: minioEndpoint(),
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
  return s3Client;
}
