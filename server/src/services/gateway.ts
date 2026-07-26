import { appendCaddySite, removeCaddySite, reloadCaddy } from '../caddy.js';
import { route53Preflight, upsertCname, deleteCname, listExistingRecords, domainResolves } from '../route53.js';
import {
  listRoutes,
  getRoutesByName,
  getRoute,
  createRoute as createRouteRow,
  deleteRoute as deleteRouteRow,
  updateRoute as updateRouteRow,
  listGatewayTrafficEvents,
  summarizeGatewayTraffic,
  summarizeGatewayTrafficByHour,
  getRouteByDomainAnyStatus,
  setRouteDomain,
  verifyRouteDomain,
  setRouteDomainDnsManaged,
} from '../db/gateway.js';
import { recordAuditLog } from '../db/audit.js';
import { getProject } from '../db.js';
import { HttpError } from './HttpError.js';
import type { CreateRouteInput, UpdateRouteInput } from './types.js';

export const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const TARGET_TYPES = new Set(['bucket', 'container', 'lambda']);
export const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function toJson(r: import('../db/gateway.js').RouteRow) {
  return {
    id: r.id,
    name: r.name,
    displayName: r.display_name || null,
    targetType: r.target_type,
    targetId: r.target_id,
    targetPort: r.target_port,
    method: r.method || null,
    pathPattern: r.path_pattern || null,
    projectId: r.project_id || null,
    domain: r.domain || null,
    domainVerified: r.domain_verified === 1,
    dnsManaged: r.domain_dns_managed === 1,
    hostedZoneId: r.domain_hosted_zone_id || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── CRUD ──────────────────────────────────────────────────────

export function list(userId?: string, projectId?: string) {
  return listRoutes(userId, projectId).map(toJson);
}

export function createRoute(userId: string | undefined, input: CreateRouteInput) {
  if (!input.name || !NAME_RE.test(input.name)) {
    throw new HttpError(400, 'Name must be lowercase letters, digits, and hyphens, starting with a letter or digit.');
  }
  if (!input.targetType || !TARGET_TYPES.has(input.targetType)) {
    throw new HttpError(400, `targetType must be one of: ${Array.from(TARGET_TYPES).join(', ')}.`);
  }
  if (!input.targetId?.trim()) {
    throw new HttpError(400, 'A targetId is required.');
  }
  if (input.targetType === 'container' && !input.targetPort) {
    throw new HttpError(400, 'A targetPort is required for container routes.');
  }

  if (input.projectId?.trim()) {
    const project = getProject(input.projectId.trim(), userId);
    if (!project) throw new HttpError(400, 'Project not found.');
  }

  const methodNorm = input.method?.trim().toUpperCase() || null;
  if (methodNorm && !VALID_METHODS.has(methodNorm)) {
    throw new HttpError(400, `Invalid method. Must be one of: ${Array.from(VALID_METHODS).join(', ')}.`);
  }

  const pathNorm = input.pathPattern?.trim() || null;
  if (pathNorm && !pathNorm.startsWith('/')) {
    throw new HttpError(400, 'pathPattern must start with "/".');
  }

  // Check for duplicate.
  const existing = getRoutesByName(input.name);
  const dup = existing.find(
    (r) => (r.method || null) === methodNorm && (r.path_pattern || null) === pathNorm,
  );
  if (dup) {
    const desc = [input.name, methodNorm, pathNorm].filter(Boolean).join(' ');
    throw new HttpError(409, `A route matching "${desc}" already exists.`);
  }

  const id = `rt-${Math.random().toString(36).slice(2, 8)}`;
  const row = createRouteRow(
    id,
    input.name,
    input.targetType,
    input.targetId.trim(),
    input.targetType === 'container' ? Number(input.targetPort) : null,
    methodNorm,
    pathNorm,
    userId,
    input.displayName?.trim() || null,
    input.projectId?.trim() || null,
  );
  recordAuditLog('gateway.route.create', 'route', row.id, userId, input.name);
  return toJson(row);
}

export function updateRoute(id: string, userId: string | undefined, input: UpdateRouteInput) {
  const row = updateRouteRow(id, { displayName: input.displayName });
  if (!row) throw new HttpError(404, 'Route not found.');
  return toJson(row);
}

export function deleteGatewayRoute(id: string, userId?: string) {
  const deleted = deleteRouteRow(id);
  if (!deleted) throw new HttpError(404, 'Route not found.');
  recordAuditLog('gateway.route.delete', 'route', id, null);
}

// ── Domain management ─────────────────────────────────────────

export function setDomain(id: string, userId: string | undefined, domain: string | null) {
  if (domain != null && typeof domain !== 'string') {
    throw new HttpError(400, 'domain must be a string or null.');
  }
  if (typeof domain === 'string' && !DOMAIN_RE.test(domain)) {
    throw new HttpError(400, 'Invalid domain format.');
  }

  const existing = getRoute(id, userId);
  if (!existing) throw new HttpError(404, 'Route not found.');

  if (domain) {
    const claimant = getRouteByDomainAnyStatus(domain);
    if (claimant && claimant.id !== id) {
      throw new HttpError(409, `Domain "${domain}" is already claimed by route "${claimant.name}".`);
    }
  }
  const updated = setRouteDomain(id, domain ?? null);
  return toJson(updated!);
}

export async function domainPreflight(id: string, userId?: string) {
  const route = getRoute(id, userId);
  if (!route) throw new HttpError(404, 'Route not found.');
  if (!route.domain) throw new HttpError(400, 'Route has no domain set.');

  const pf = await route53Preflight(route.domain);
  return {
    available: pf.available,
    error: pf.error || null,
    matchedZone: pf.matchedZone ? { id: pf.matchedZone.id, name: pf.matchedZone.name } : null,
    isApex: pf.isApex,
    dnsManaged: route.domain_dns_managed === 1,
    hostedZoneId: route.domain_hosted_zone_id || null,
  };
}

export async function enableDomain(id: string, userId?: string) {
  const route = getRoute(id, userId);
  if (!route) throw new HttpError(404, 'Route not found.');
  if (!route.domain) throw new HttpError(400, 'Route has no domain set. PATCH /domain first.');

  const pf = await route53Preflight(route.domain);
  if (pf.isApex) {
    throw new HttpError(400, `Apex (root) domains are not supported yet. Use a subdomain like www.${route.domain}`);
  }

  if (pf.matchedZone) {
    await upsertCname(pf.matchedZone.id, route.domain);
    setRouteDomainDnsManaged(route.id, pf.matchedZone.id);
    await appendCaddySite(route.domain);
    await reloadCaddy();
    verifyRouteDomain(route.id);
    recordAuditLog('gateway.domain.enable', 'route', route.id, userId, route.domain);

    const updated = getRoute(route.id, userId);
    return { ...toJson(updated!), dnsInstructions: null };
  }

  if (await domainResolves(route.domain)) {
    await appendCaddySite(route.domain);
    await reloadCaddy();
    verifyRouteDomain(route.id);

    const updated = getRoute(route.id, userId);
    return { ...toJson(updated!), dnsInstructions: null };
  }

  const updated = getRoute(route.id, userId);
  return {
    ...toJson(updated!),
    dnsInstructions: `Create a CNAME record pointing ${route.domain} to dockyard-ai.com, then call enable again. TLS will provision automatically once DNS resolves.`,
  };
}

export function checkDomainStatus(id: string, userId?: string) {
  const route = getRoute(id, userId);
  if (!route) throw new HttpError(404, 'Route not found.');
  return {
    domain: route.domain || null,
    verified: route.domain_verified === 1,
    certStatus: route.domain_verified === 1 ? 'active' : route.domain ? 'pending' : null,
    dnsManaged: route.domain_dns_managed === 1,
    hostedZoneId: route.domain_hosted_zone_id || null,
    dnsInstructions: route.domain && route.domain_verified === 0
      ? `Create a CNAME record pointing ${route.domain} to dockyard-ai.com. TLS will provision automatically.`
      : null,
  };
}

export async function removeDomain(id: string, userId?: string) {
  const route = getRoute(id, userId);
  if (!route) throw new HttpError(404, 'Route not found.');
  if (!route.domain) throw new HttpError(400, 'Route has no domain set.');

  if (route.domain_dns_managed === 1 && route.domain_hosted_zone_id) {
    try { await deleteCname(route.domain_hosted_zone_id, route.domain); }
    catch { /* best-effort */ }
  }

  await removeCaddySite(route.domain);
  await reloadCaddy();
  setRouteDomain(route.id, null);
  recordAuditLog('gateway.domain.delete', 'route', route.id, userId, route.domain);
}

// ── Traffic ───────────────────────────────────────────────────

function stringQuery(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function integerQuery(value: unknown, fallback: number, label: string, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `${label} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 30;
const DEFAULT_REQUEST_LIMIT = 100;
const MAX_REQUEST_LIMIT = 200;

function trafficEventJson(r: import('../db/gateway.js').GatewayTrafficEventRow) {
  return {
    id: r.id, occurredAt: r.occurred_at, gatewayName: r.gateway_name, routeId: r.route_id,
    targetType: r.target_type, method: r.method, path: r.path, statusCode: r.status_code,
    durationMs: r.duration_ms, requestBytes: r.request_bytes, responseBytes: r.response_bytes,
    errorClassification: r.error_classification,
  };
}

function trafficSummaryJson(r: import('../db/gateway.js').GatewayTrafficSummaryRow) {
  return {
    gatewayName: r.gateway_name, routeId: r.route_id, targetType: r.target_type,
    routeMethod: r.route_method, routePathPattern: r.route_path_pattern,
    requestCount: r.request_count, successfulRequests: r.success_count,
    clientErrorRequests: r.client_error_count, serverErrorRequests: r.server_error_count,
    avgDurationMs: r.avg_duration_ms, maxDurationMs: r.max_duration_ms,
    totalRequestBytes: r.total_request_bytes, totalResponseBytes: r.total_response_bytes,
    lastSeenAt: r.last_seen_at, errorCounts: r.error_counts,
  };
}

export function trafficSummary(filters: {
  windowHours?: unknown; gatewayName?: unknown; routeId?: unknown; targetType?: unknown;
}) {
  const windowHours = integerQuery(filters.windowHours, DEFAULT_WINDOW_HOURS, 'windowHours', 1, MAX_WINDOW_HOURS);
  const until = new Date();
  const since = new Date(until.getTime() - windowHours * 60 * 60 * 1000);
  const gatewayName = stringQuery(filters.gatewayName);
  const routeId = stringQuery(filters.routeId);
  const targetType = stringQuery(filters.targetType);
  if (targetType && !TARGET_TYPES.has(targetType)) {
    throw new HttpError(400, `targetType must be one of: ${Array.from(TARGET_TYPES).join(', ')}.`);
  }

  const rows = summarizeGatewayTraffic({
    since: since.toISOString(), until: until.toISOString(),
    gatewayName, routeId, targetType,
  });

  return {
    windowHours, since: since.toISOString(), until: until.toISOString(),
    filters: { gatewayName, routeId, targetType },
    totalRequests: rows.reduce((sum, row) => sum + row.request_count, 0),
    routes: rows.map(trafficSummaryJson),
  };
}

export function trafficRequests(filters: {
  windowHours?: unknown; limit?: unknown; gatewayName?: unknown; routeId?: unknown;
  targetType?: unknown; method?: unknown; statusCode?: unknown; errorClassification?: unknown;
}) {
  const windowHours = integerQuery(filters.windowHours, DEFAULT_WINDOW_HOURS, 'windowHours', 1, MAX_WINDOW_HOURS);
  const limit = integerQuery(filters.limit, DEFAULT_REQUEST_LIMIT, 'limit', 1, MAX_REQUEST_LIMIT);
  const until = new Date();
  const since = new Date(until.getTime() - windowHours * 60 * 60 * 1000);
  const gatewayName = stringQuery(filters.gatewayName);
  const routeId = stringQuery(filters.routeId);
  const targetType = stringQuery(filters.targetType);
  const method = stringQuery(filters.method)?.toUpperCase() || null;
  const errorClassification = stringQuery(filters.errorClassification);
  const statusCode = filters.statusCode == null ? null : integerQuery(filters.statusCode, 0, 'statusCode', 100, 599);

  if (targetType && !TARGET_TYPES.has(targetType)) {
    throw new HttpError(400, `targetType must be one of: ${Array.from(TARGET_TYPES).join(', ')}.`);
  }
  if (method && !VALID_METHODS.has(method)) {
    throw new HttpError(400, `method must be one of: ${Array.from(VALID_METHODS).join(', ')}.`);
  }

  const result = listGatewayTrafficEvents(
    { since: since.toISOString(), until: until.toISOString(), gatewayName, routeId, targetType, method, statusCode, errorClassification },
    limit,
  );

  return {
    windowHours, since: since.toISOString(), until: until.toISOString(), limit,
    filters: { gatewayName, routeId, targetType, method, statusCode, errorClassification },
    totalMatched: result.totalMatched,
    requests: result.events.map(trafficEventJson),
  };
}

export function trafficTimeseries(windowHours?: unknown) {
  const hours = integerQuery(windowHours, DEFAULT_WINDOW_HOURS, 'windowHours', 1, MAX_WINDOW_HOURS);
  const until = new Date();
  const since = new Date(until.getTime() - hours * 60 * 60 * 1000);
  const rows = summarizeGatewayTrafficByHour({ since: since.toISOString(), until: until.toISOString() });
  return {
    windowHours: hours, since: since.toISOString(), until: until.toISOString(),
    buckets: rows.map((row) => ({
      start: row.bucket_start, requestCount: row.request_count,
      successfulRequests: row.success_count, clientErrorRequests: row.client_error_count,
      serverErrorRequests: row.server_error_count,
    })),
  };
}

// ── DNS records ───────────────────────────────────────────────

export async function listDnsZones() {
  const pf = await route53Preflight('example.com');
  return { available: pf.available, zones: pf.zones, error: pf.error || null };
}

export async function listDnsRecords(zoneId: string, name?: string) {
  const records = name ? await listExistingRecords(zoneId, name) : [];
  return { records };
}

export async function createDnsRecord(zoneId: string, name: string) {
  return upsertCname(zoneId, name);
}

export async function deleteDnsRecord(zoneId: string, name: string) {
  await deleteCname(zoneId, name);
}
