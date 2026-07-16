import { useEffect, useState } from 'react';
import type { Bucket, Container, GatewayRoute, LambdaFunction } from '../types';
import { api } from '../api';

const TARGET_ICON: Record<string, string> = { bucket: '🪣', container: '📦', lambda: '⚡' };
const METHODS = ['ANY', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

export function GatewayPanel() {
  const [routes, setRoutes] = useState<GatewayRoute[]>([]);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [containers, setContainers] = useState<Container[]>([]);
  const [functions, setFunctions] = useState<LambdaFunction[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
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
  }, []);

  async function loadRoutes() {
    try {
      setRoutes(await api.gatewayList());
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const runningContainers = containers.filter((c) => c.state === 'running');
  const selectedContainer = runningContainers.find((c) => c.id === containerId);

  function resetForm() {
    setName('');
    setTargetType('bucket');
    setBucketId('');
    setContainerId('');
    setContainerPort('');
    setFunctionId('');
    setMethod('ANY');
    setPathPattern('');
  }

  async function createRoute() {
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
      setCreating(false);
      await loadRoutes();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function removeRoute(id: string) {
    if (!confirm('Delete this route?')) return;
    try {
      await api.gatewayDelete(id);
      setRoutes((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      alert((err as Error).message);
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
          Gateway <span className="count">{routes.length}</span>
        </h2>
        <button className="btn btn--primary btn--sm" onClick={() => setCreating(!creating)}>
          {creating ? 'Cancel' : '+ New route'}
        </button>
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
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-api" spellCheck={false} />
            </label>

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
              Multiple routes can share the same name — the most specific method + path match wins. Leave both as
              ANY / blank to catch everything under this name.
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

            <button className="btn btn--primary" disabled={!name.trim()} onClick={createRoute}>
              Create route
            </button>
          </div>
        </div>
      )}

      {routes.length === 0 ? (
        <p className="empty">No routes yet. Map a bucket, container, or function to a clean URL.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Route</th>
                <th>Method</th>
                <th>Path</th>
                <th>Target</th>
                <th className="actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((r) => (
                <tr key={r.id}>
                  <td className="mono">/gw/{r.name}/…</td>
                  <td>
                    <span className="chip">{r.method || 'ANY'}</span>
                  </td>
                  <td className="mono muted">{r.pathPattern || '*'}</td>
                  <td className="muted">
                    {TARGET_ICON[r.targetType]} {targetLabel(r)}
                  </td>
                  <td className="actions-col">
                    <button className="btn btn--sm btn--danger" onClick={() => removeRoute(r.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
