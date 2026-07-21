import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Bucket, Container, GatewayRoute, GatewayTrafficRequest, GatewayTrafficSummary, LambdaFunction } from '../types';
import { api } from '../api';
import { onRefresh } from '../refresh';
import { AppIcon } from '../icons';
import { bytes } from '../format';
import { useToast } from '../ToastContext';

const TARGET_ICON = {
  bucket: <AppIcon name="bucket" />,
  container: <AppIcon name="container" />,
  lambda: <AppIcon name="function" />,
};

export function GatewayList() {
  const navigate = useNavigate();
  const [routes, setRoutes] = useState<GatewayRoute[]>([]);
  const [containers, setContainers] = useState<Container[]>([]);
  const [functions, setFunctions] = useState<LambdaFunction[]>([]);
  const [traffic, setTraffic] = useState<GatewayTrafficSummary | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'table' | 'grid'>('table');
  const toast = useToast();

  useEffect(() => {
    loadRoutes();
    api.containers().then(setContainers).catch(() => {});
    api.lambdaListFunctions().then(setFunctions).catch(() => {});
    api.gatewayTrafficSummary().then(setTraffic).catch(() => {});
  }, []);

  // Reload when the assistant mutates gateway routes, containers, or functions.
  useEffect(() => onRefresh(() => {
    loadRoutes();
    api.containers().then(setContainers).catch(() => {});
    api.lambdaListFunctions().then(setFunctions).catch(() => {});
    api.gatewayTrafficSummary().then(setTraffic).catch(() => {});
  }), []);

  async function loadRoutes() {
    try {
      setRoutes(await api.gatewayList());
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function targetLabel(r: GatewayRoute): string {
    if (r.targetType === 'bucket') return r.targetId;
    if (r.targetType === 'container') {
      const c = containers.find((x) => x.id === r.targetId);
      return c?.name || r.targetId.slice(0, 12);
    }
    const fn = functions.find((x) => x.id === r.targetId);
    return fn?.name || r.targetId;
  }

  async function saveDisplayName(group: GatewayRoute[]) {
    const val = editValue.trim();
    const displayName = val || null;
    // Update all endpoints sharing this route name.
    try {
      for (const r of group) {
        await api.gatewayUpdate(r.id, displayName);
      }
      loadRoutes();
      setEditing(null);
      toast.success('Route name updated.');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const groups = Object.values(
    routes.reduce<Record<string, GatewayRoute[]>>((acc, r) => {
      (acc[r.name] ??= []).push(r);
      return acc;
    }, {}),
  );
  const requestsByGateway = new Map<string, number>();
  for (const route of traffic?.routes ?? []) {
    requestsByGateway.set(route.gatewayName, (requestsByGateway.get(route.gatewayName) ?? 0) + route.requestCount);
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>
          Gateway <span className="count">{groups.length}</span>
        </h2>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            className={`btn btn--sm ${viewMode === 'table' ? 'btn--primary' : ''}`}
            onClick={() => setViewMode('table')}
            title="Table view"
          >
            ☰
          </button>
          <button
            className={`btn btn--sm ${viewMode === 'grid' ? 'btn--primary' : ''}`}
            onClick={() => setViewMode('grid')}
            title="Grid view"
          >
            ▦
          </button>
          <button className="btn btn--primary btn--sm" onClick={() => setCreating(true)}>
            + New route
          </button>
        </div>
      </div>

      {error && <p className="muted empty-sm">{error}</p>}

      {creating && (
        <div className="modal-backdrop" onClick={() => setCreating(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head">
              <h3>New gateway route</h3>
              <button className="btn btn--ghost" onClick={() => setCreating(false)}>
                Close
              </button>
            </div>
            <label className="field">
              <span>Route name (used as /gw/&lt;name&gt;/...)</span>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="my-api"
                spellCheck={false}
                autoFocus
              />
            </label>
            <p className="hint">
              A route groups any number of endpoints (method + path combos), each pointing at its own target.
              Add endpoints from the route's detail page next.
            </p>
            <button
              className="btn btn--primary"
              disabled={!newName.trim()}
              onClick={() => navigate(`/gateway/${newName.trim()}`)}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {groups.length === 0 ? (
        <p className="empty">No routes yet. Map a bucket, container, or function to a clean URL.</p>
      ) : viewMode === 'table' ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Route</th>
                <th>EP</th>
                <th>Targets</th>
                <th className="num">Req (24h)</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group[0].name} onClick={() => navigate(`/gateway/${group[0].name}`)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    {editing === group[0].name ? (
                      <input
                        className="gateway-name-edit"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => saveDisplayName(group)}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveDisplayName(group); if (e.key === 'Escape') setEditing(null); }}
                        autoFocus
                      />
                    ) : (
                      <span
                        className="gateway-name-cell"
                        title="Click to rename"
                        onClick={() => { setEditing(group[0].name); setEditValue(group[0].displayName || group[0].name); }}
                      >
                        {group[0].displayName || group[0].name}
                      </span>
                    )}
                  </td>
                  <td className="mono">
                    <a
                      href={`/gw/${group[0].name}/`}
                      target="_blank"
                      rel="noreferrer"
                      className="instance-link"
                      onClick={(e) => e.stopPropagation()}
                    >
                      /gw/{group[0].name}/…
                    </a>
                  </td>
                  <td className="muted">{group.length}</td>
                  <td className="muted">
                    {group.map((r, i) => (
                      <span key={r.id} title={targetLabel(r)}>
                        {i > 0 && ' '}
                        {TARGET_ICON[r.targetType]}
                      </span>
                    ))}
                  </td>
                  <td className="num mono">{requestsByGateway.get(group[0].name) ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="gateway-grid">
          {groups.map((group) => (
            <div
              key={group[0].name}
              className="gateway-card"
              onClick={() => navigate(`/gateway/${group[0].name}`)}
            >
              <div className="gateway-card__head">
                <span
                  className="gateway-card__name"
                  title="Click to rename"
                  onClick={(e) => { e.stopPropagation(); setEditing(group[0].name); setEditValue(group[0].displayName || group[0].name); }}
                >
                  {editing === group[0].name ? (
                    <input
                      className="gateway-name-edit"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => saveDisplayName(group)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveDisplayName(group); if (e.key === 'Escape') setEditing(null); }}
                      autoFocus
                    />
                  ) : (
                    group[0].displayName || group[0].name
                  )}
                </span>
                <span className="gateway-card__ep">{group.length} EP</span>
              </div>
              <div className="gateway-card__route mono">
                <a
                  href={`/gw/${group[0].name}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="instance-link"
                  onClick={(e) => e.stopPropagation()}
                >
                  /gw/{group[0].name}/…
                </a>
              </div>
              <div className="gateway-card__footer">
                <span className="gateway-card__targets">
                  {group.map((r) => (
                    <span key={r.id} title={targetLabel(r)} style={{ marginRight: 4 }}>
                      {TARGET_ICON[r.targetType]}
                    </span>
                  ))}
                </span>
                <span className="gateway-card__req mono">
                  {requestsByGateway.get(group[0].name) ?? 0} req
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const METHODS = ['ANY', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

export function GatewayDetail({ name }: { name: string }) {
  const navigate = useNavigate();
  const [routes, setRoutes] = useState<GatewayRoute[]>([]);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [containers, setContainers] = useState<Container[]>([]);
  const [functions, setFunctions] = useState<LambdaFunction[]>([]);
  const [traffic, setTraffic] = useState<GatewayTrafficSummary | null>(null);
  const [recentRequests, setRecentRequests] = useState<GatewayTrafficRequest[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const [targetType, setTargetType] = useState<'bucket' | 'container' | 'lambda'>('bucket');
  const [bucketId, setBucketId] = useState('');
  const [containerId, setContainerId] = useState('');
  const [containerPort, setContainerPort] = useState<number | ''>('');
  const [functionId, setFunctionId] = useState('');
  const [method, setMethod] = useState('ANY');
  const [pathPattern, setPathPattern] = useState('');

  useEffect(() => {
    loadRoutes();
    api.bucketList().then(setBuckets).catch(() => {});
    api.containers().then(setContainers).catch(() => {});
    api.lambdaListFunctions().then(setFunctions).catch(() => {});
    api.gatewayTrafficSummary(name).then(setTraffic).catch(() => {});
    api.gatewayTrafficRequests(name).then((response) => setRecentRequests(response.requests)).catch(() => {});
  }, [name]);

  // Reload when the assistant mutates routes or their target resources.
  useEffect(() => onRefresh(() => {
    loadRoutes();
    api.bucketList().then(setBuckets).catch(() => {});
    api.containers().then(setContainers).catch(() => {});
    api.lambdaListFunctions().then(setFunctions).catch(() => {});
    api.gatewayTrafficSummary(name).then(setTraffic).catch(() => {});
    api.gatewayTrafficRequests(name).then((response) => setRecentRequests(response.requests)).catch(() => {});
  }), [name]);

  async function loadRoutes() {
    try {
      const all = await api.gatewayList();
      setRoutes(all.filter((r) => r.name === name));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const runningContainers = containers.filter((c) => c.state === 'running');
  const selectedContainer = runningContainers.find((c) => c.id === containerId);
  const trafficTotals = (traffic?.routes ?? []).reduce(
    (totals, route) => ({
      requests: totals.requests + route.requestCount,
      ingress: totals.ingress + route.totalRequestBytes,
      egress: totals.egress + route.totalResponseBytes,
      errors: totals.errors + route.serverErrorRequests,
    }),
    { requests: 0, ingress: 0, egress: 0, errors: 0 },
  );

  // ── Preview ────────────────────────────────────────────────────────
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState(0);

  useEffect(() => {
    if (routes.length === 0) { setPreviewSrc(null); return; }
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const res = await fetch(api.gatewayPreviewUrl(name));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewSrc((prev) => { if (prev) URL.revokeObjectURL(prev); return objectUrl; });
      } catch (err) {
        if (!cancelled) setPreviewError((err as Error).message);
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [name, routes.length, previewKey]);

  function refreshPreview() {
    setPreviewKey((k) => k + 1);
  }

  function resetForm() {
    setTargetType('bucket');
    setBucketId('');
    setContainerId('');
    setContainerPort('');
    setFunctionId('');
    setMethod('ANY');
    setPathPattern('');
  }

  async function addEndpoint() {
    setError(null);
    try {
      const methodField = method === 'ANY' ? undefined : method;
      const pathField = pathPattern.trim() || undefined;

      if (targetType === 'bucket') {
        if (!bucketId) throw new Error('Choose a bucket.');
        await api.gatewayCreate({ name, targetType, targetId: bucketId, method: methodField, pathPattern: pathField });
      } else if (targetType === 'container') {
        if (!containerId || containerPort === '') throw new Error('Choose a container and port.');
        await api.gatewayCreate({
          name,
          targetType,
          targetId: containerId,
          targetPort: Number(containerPort),
          method: methodField,
          pathPattern: pathField,
        });
      } else {
        if (!functionId) throw new Error('Choose a function.');
        await api.gatewayCreate({ name, targetType, targetId: functionId, method: methodField, pathPattern: pathField });
      }
      resetForm();
      setAdding(false);
      await loadRoutes();
      toast.success('Endpoint added.');
    } catch (err) {
      setError((err as Error).message);
      toast.error((err as Error).message);
    }
  }

  async function removeEndpoint(id: string) {
    if (!confirm('Delete this endpoint?')) return;
    try {
      await api.gatewayDelete(id);
      const remaining = routes.filter((r) => r.id !== id);
      setRoutes(remaining);
      toast.success('Endpoint removed.');
      if (remaining.length === 0) navigate('/gateway');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  function targetLabel(r: GatewayRoute): string {
    if (r.targetType === 'bucket') return r.targetId;
    if (r.targetType === 'container') {
      const c = containers.find((x) => x.id === r.targetId);
      return `${c?.name || r.targetId.slice(0, 12)} :${r.targetPort}`;
    }
    const fn = functions.find((x) => x.id === r.targetId);
    return fn?.name || r.targetId;
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>
          <span className="mono">/gw/{name}</span> <span className="count">{routes.length}</span>
        </h2>
        <button className="btn btn--primary btn--sm" onClick={() => setAdding(true)}>
          + Add endpoint
        </button>
      </div>

      {error && <p className="muted empty-sm">{error}</p>}

      {adding && (
        <div className="modal-backdrop" onClick={() => setAdding(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head">
              <h3>Add endpoint to /gw/{name}</h3>
              <button className="btn btn--ghost" onClick={() => setAdding(false)}>
                Close
              </button>
            </div>

            <div className="port-row">
              <label className="field" style={{ flex: 1 }}>
                <span>Method</span>
                <select value={method} onChange={(e) => setMethod(e.target.value)}>
                  {METHODS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ flex: 2 }}>
                <span>Path (optional — matches exactly, e.g. /getItem)</span>
                <input
                  value={pathPattern}
                  onChange={(e) => setPathPattern(e.target.value)}
                  placeholder="/getItem"
                  spellCheck={false}
                />
              </label>
            </div>
            <p className="hint">
              The most specific method + path match wins. Leave both as ANY / blank to catch everything under this route.
            </p>

            <label className="field">
              <span>Target type</span>
              <select value={targetType} onChange={(e) => setTargetType(e.target.value as typeof targetType)}>
                <option value="bucket">Bucket (static files)</option>
                <option value="container">Container (reverse proxy)</option>
                <option value="lambda">Lambda function</option>
              </select>
            </label>

            {targetType === 'bucket' && (
              <label className="field">
                <span>Bucket</span>
                <select value={bucketId} onChange={(e) => setBucketId(e.target.value)}>
                  <option value="">Select a bucket…</option>
                  {buckets.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {targetType === 'container' && (
              <>
                <label className="field">
                  <span>Container</span>
                  <select
                    value={containerId}
                    onChange={(e) => {
                      setContainerId(e.target.value);
                      setContainerPort('');
                    }}
                  >
                    <option value="">Select a running container…</option>
                    {runningContainers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name || c.id.slice(0, 12)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Port</span>
                  <select
                    value={containerPort}
                    onChange={(e) => setContainerPort(e.target.value ? Number(e.target.value) : '')}
                    disabled={!selectedContainer}
                  >
                    <option value="">Select a port…</option>
                    {selectedContainer?.ports.map((p) => (
                      <option key={p.privatePort} value={p.privatePort}>
                        {p.privatePort}
                        {p.publicPort ? ` (published as ${p.publicPort})` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}

            {targetType === 'lambda' && (
              <label className="field">
                <span>Function</span>
                <select value={functionId} onChange={(e) => setFunctionId(e.target.value)}>
                  <option value="">Select a function…</option>
                  {functions.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <button className="btn btn--primary" onClick={addEndpoint}>
              Add endpoint
            </button>
          </div>
        </div>
      )}

      {routes.length === 0 ? (
        <p className="empty">No endpoints yet for this route.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Method</th>
                <th>Path</th>
                <th>Target</th>
                <th className="actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((r) => {
                const href = `/gw/${name}${r.pathPattern || '/'}`;
                return (
                  <tr key={r.id}>
                    <td>
                      <span className="chip">{r.method || 'ANY'}</span>
                    </td>
                    <td className="mono muted">
                      <a href={href} target="_blank" rel="noreferrer" className="instance-link">
                        {r.pathPattern || '*'}
                      </a>
                    </td>
                    <td className="muted">
                      {TARGET_ICON[r.targetType]} {targetLabel(r)}
                    </td>
                    <td className="actions-col">
                      <button className="btn btn--sm btn--danger" onClick={() => removeEndpoint(r.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {routes.length > 0 && (
        <section className="gateway-preview">
          <div className="detail-section__head">
            <h3 className="detail-section__title">Preview</h3>
            <button
              className="btn btn--sm"
              onClick={refreshPreview}
              disabled={previewLoading}
            >
              {previewLoading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
          {previewError ? (
            <p className="muted empty-sm">{previewError}</p>
          ) : previewSrc ? (
            <div className="gateway-preview__frame">
              <img
                src={previewSrc}
                alt={`Preview of /gw/${name}`}
                onLoad={() => setPreviewLoading(false)}
                onError={() => { setPreviewLoading(false); setPreviewError('Preview failed — the gateway route may not return HTML.'); }}
                style={{ width: '100%', border: '1px solid var(--border)', borderRadius: '6px' }}
              />
            </div>
          ) : null}
        </section>
      )}

      <section className="gateway-traffic">
        <div className="detail-section__head">
          <h3 className="detail-section__title">Traffic (last 24 hours)</h3>
          <button
            className="btn btn--sm"
            onClick={() => {
              api.gatewayTrafficSummary(name).then(setTraffic).catch(() => {});
              api.gatewayTrafficRequests(name).then((response) => setRecentRequests(response.requests)).catch(() => {});
            }}
          >
            Refresh
          </button>
        </div>
        <div className="gateway-traffic__summary">
          <span><strong>{trafficTotals.requests}</strong> requests</span>
          <span><strong>{bytes(trafficTotals.ingress)}</strong> in</span>
          <span><strong>{bytes(trafficTotals.egress)}</strong> out</span>
          <span><strong>{trafficTotals.errors}</strong> server errors</span>
        </div>
        {recentRequests.length === 0 ? (
          <p className="empty-sm">No gateway requests recorded in the last 24 hours.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Request</th>
                  <th>Status</th>
                  <th className="num">Latency</th>
                  <th className="num">In / out</th>
                </tr>
              </thead>
              <tbody>
                {recentRequests.map((request) => (
                  <tr key={request.id}>
                    <td className="muted">{new Date(request.occurredAt).toLocaleTimeString()}</td>
                    <td className="mono">{request.method} {request.path}</td>
                    <td>
                      <span className={`db-status-pill ${request.statusCode >= 500 ? 'db-status-pill--error' : request.statusCode >= 400 ? 'db-status-pill--neutral' : 'db-status-pill--ok'}`}>
                        {request.statusCode}
                      </span>
                    </td>
                    <td className="num mono">{request.durationMs}ms</td>
                    <td className="num mono">{bytes(request.requestBytes)} / {bytes(request.responseBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
