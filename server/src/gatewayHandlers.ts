import type { Request, Response } from 'express';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { docker, isSelfContainerized, remoteDockerHost } from './docker.js';
import { getS3Client } from './minio.js';
import {
  getRoutesByName,
  getFunction,
  getFunctionEnv,
  recordGatewayTrafficEvent,
  type RouteRow,
} from './db.js';
import { runLambda, entryPathOf, fullFileSet } from './routes/lambda.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface GatewayTelemetryState {
  gatewayName: string;
  routeId: string | null;
  targetType: string | null;
  requestBytes: number;
  errorClassification: string | null;
  entryPoint?: 'gw_prefix' | 'custom_domain';
}

/** AWS API Gateway REST API "Lambda proxy integration" event shape. */
interface ProxyEvent {
  httpMethod: string;
  path: string;
  headers: Record<string, string | undefined>;
  queryStringParameters: Record<string, string> | null;
  pathParameters: Record<string, string> | null;
  body: string | null;
  isBase64Encoded: boolean;
}

/** The shape a handler must print to stdout. */
interface ProxyResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

// ── Telemetry helpers (shared between /gw and host-based routing) ─────────

export function parseContentLength(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function chunkByteLength(chunk: unknown, encoding?: BufferEncoding): number {
  if (chunk == null) return 0;
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, encoding);
  return Buffer.byteLength(String(chunk));
}

export function setGatewayResolution(telem: GatewayTelemetryState, route: RouteRow | null): void {
  telem.routeId = route?.id || null;
  telem.targetType = route?.target_type || null;
}

export function setGatewayError(telem: GatewayTelemetryState, classification: string): void {
  telem.errorClassification = classification;
}

export function updateGatewayRequestBytes(telem: GatewayTelemetryState, bytes: number): void {
  telem.requestBytes = Math.max(telem.requestBytes, Math.round(bytes));
}

export function finalizeGatewayErrorClassification(
  classification: string | null,
  statusCode: number,
  finished: boolean,
): string | null {
  if (!finished) return 'client_aborted';
  if (classification) return classification;
  if (statusCode >= 500) return 'upstream_server_error';
  if (statusCode >= 400) return 'upstream_client_error';
  return null;
}

function sendGatewayJsonError(
  telem: GatewayTelemetryState,
  res: Response,
  statusCode: number,
  classification: string,
  error: string,
  extra: Record<string, unknown> = {},
): void {
  setGatewayError(telem, classification);
  res.status(statusCode).json({ error, ...extra });
}

// ── Bucket helper ──────────────────────────────────────────────────────────

async function fetchBucketObject(bucket: string, key: string) {
  const client = getS3Client();
  return client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
}

// ── Route handlers ─────────────────────────────────────────────────────────

export async function handleBucket(route: RouteRow, req: Request, res: Response, telem: GatewayTelemetryState): Promise<void> {
  let key = req.path.replace(/^\//, '');
  if (key === '' || key.endsWith('/')) key += 'index.html';

  try {
    const out = await fetchBucketObject(route.target_id, key);
    res.set('Content-Type', out.ContentType || 'application/octet-stream');
    if (out.ContentLength != null) res.set('Content-Length', String(out.ContentLength));
    (out.Body as NodeJS.ReadableStream).pipe(res);
    return;
  } catch {
    /* fall through to SPA fallback below */
  }

  const looksLikeFile = /\.[a-zA-Z0-9]+$/.test(key);
  if (!looksLikeFile && key !== 'index.html') {
    try {
      const out = await fetchBucketObject(route.target_id, 'index.html');
      res.set('Content-Type', out.ContentType || 'text/html');
      if (out.ContentLength != null) res.set('Content-Length', String(out.ContentLength));
      (out.Body as NodeJS.ReadableStream).pipe(res);
      return;
    } catch {
      /* no index.html either — fall through to 404 */
    }
  }

  sendGatewayJsonError(
    telem, res, 404, 'bucket_object_not_found',
    `Object "${key}" not found in bucket "${route.target_id}".`,
  );
}

export async function handleContainer(route: RouteRow, req: Request, res: Response, telem: GatewayTelemetryState): Promise<void> {
  let info;
  try {
    info = await docker.getContainer(route.target_id).inspect();
  } catch {
    sendGatewayJsonError(telem, res, 502, 'container_lookup_failed', 'Target container is not available.');
    return;
  }
  if (!info.State?.Running) {
    sendGatewayJsonError(telem, res, 502, 'container_not_running', 'Target container is not running.');
    return;
  }

  const port = route.target_port;
  let target: string;
  if (isSelfContainerized()) {
    target = `http://${(info.Name || '').replace(/^\//, '')}:${port}`;
  } else {
    const binding = info.NetworkSettings?.Ports?.[`${port}/tcp`]?.[0];
    if (!binding?.HostPort) {
      sendGatewayJsonError(
        telem, res, 502, 'container_port_unpublished',
        `Container port ${port} is not published to the host — required to reach it from this process.`,
      );
      return;
    }
    target = `http://${remoteDockerHost() ?? '127.0.0.1'}:${binding.HostPort}`;
  }

  if (req.headers.upgrade?.toLowerCase() === 'websocket') {
    const http = await import('node:http');
    const wsTarget = target.replace(/^http/, 'ws') + req.url;
    const proxyReq = http.request(wsTarget, {
      headers: { ...req.headers, host: new URL(target).host },
    });
    proxyReq.on('upgrade', (proxyRes, socket, head) => {
      res.writeHead(proxyRes.statusCode ?? 101, proxyRes.headers);
      socket.write(head);
      socket.pipe(res.socket as unknown as NodeJS.WritableStream);
      (res.socket as unknown as NodeJS.ReadableStream).pipe(socket);
    });
    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        sendGatewayJsonError(telem, res, 502, 'container_proxy_error', err.message);
      }
    });
    proxyReq.end();
    return;
  }

  const proxy = createProxyMiddleware({ target, changeOrigin: true });
  proxy(req, res, (err?: unknown) => {
    if (err && !res.headersSent) {
      sendGatewayJsonError(telem, res, 502, 'container_proxy_error', String(err));
    }
  });
}

export async function handleLambda(route: RouteRow, req: Request, res: Response, telem: GatewayTelemetryState): Promise<void> {
  const fn = getFunction(route.target_id);
  if (!fn) {
    sendGatewayJsonError(telem, res, 404, 'lambda_target_missing', 'Target function no longer exists.');
    return;
  }

  const bodyBuf = req.body as Buffer | undefined;
  if (bodyBuf) updateGatewayRequestBytes(telem, bodyBuf.length);
  const event: ProxyEvent = {
    httpMethod: req.method,
    path: req.path,
    headers: req.headers as Record<string, string | undefined>,
    queryStringParameters: Object.keys(req.query).length > 0 ? (req.query as Record<string, string>) : null,
    pathParameters: null,
    body: bodyBuf && bodyBuf.length > 0 ? bodyBuf.toString('utf8') : null,
    isBase64Encoded: false,
  };

  const packages = (fn.packages || '').trim().split(/\s+/).filter(Boolean);
  const envVars = Object.entries(getFunctionEnv(fn.id)).map(([k, v]) => `${k}=${v}`);
  const result = await runLambda(
    fn.runtime,
    fullFileSet(fn),
    entryPathOf(fn),
    packages,
    [...envVars, `DOCKYARD_REQUEST=${JSON.stringify(event)}`],
  );

  if (result.exitCode !== 0) {
    sendGatewayJsonError(
      telem, res, 502, 'lambda_execution_failed',
      result.stderr || `Function exited with code ${result.exitCode}`,
      { stdout: result.stdout },
    );
    return;
  }

  let proxyResponse: ProxyResponse;
  try {
    proxyResponse = JSON.parse(result.stdout.trim());
  } catch {
    sendGatewayJsonError(
      telem, res, 502, 'lambda_malformed_response',
      'Malformed Lambda proxy response: function did not print valid JSON to stdout.',
      { stdout: result.stdout },
    );
    return;
  }
  if (typeof proxyResponse.statusCode !== 'number') {
    sendGatewayJsonError(
      telem, res, 502, 'lambda_malformed_response',
      'Malformed Lambda proxy response: missing numeric "statusCode".',
      { stdout: result.stdout },
    );
    return;
  }

  if (proxyResponse.headers) {
    for (const [k, v] of Object.entries(proxyResponse.headers)) res.set(k, v);
  }
  const body = proxyResponse.body ?? '';
  res.status(proxyResponse.statusCode).send(proxyResponse.isBase64Encoded ? Buffer.from(body, 'base64') : body);
}
