import { useCallback, useEffect, useState } from 'react';
import type { Container, ContainerDetail } from '../types';
import { bytes, timeAgo } from '../format';
import { api } from '../api';

interface Props {
  container: Container;
  onClose: () => void;
  onChanged: () => void;
  onRelaunch: (detail: ContainerDetail) => void;
}

const RUNNING = new Set(['running', 'restarting']);

/** Guess the best shell for an image: /bin/bash for Debian/Ubuntu, /bin/sh for Alpine/BusyBox. */
function guessShell(image: string): string {
  const lower = image.toLowerCase();
  if (lower.includes('alpine') || lower.includes('busybox') || lower.includes('slim')) {
    return '/bin/sh';
  }
  return '/bin/bash';
}

export function InstanceDetail({ container, onClose, onChanged, onRelaunch }: Props) {
  const [detail, setDetail] = useState<ContainerDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [logText, setLogText] = useState<string>('');
  const [logsLoading, setLogsLoading] = useState(false);

  // Fetch full inspect data on mount.
  useEffect(() => {
    let cancelled = false;
    api
      .inspect(container.id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) setLoadError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [container.id]);

  // Load logs.
  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      setLogText((await api.logs(container.id)) || '(no output)');
    } catch (err) {
      setLogText((err as Error).message);
    } finally {
      setLogsLoading(false);
    }
  }, [container.id]);

  async function run(id: string, fn: () => Promise<unknown>) {
    setPending(id);
    try {
      await fn();
      onChanged();
      // Re-fetch inspect data so state/config stays current.
      const d = await api.inspect(id);
      setDetail(d);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setPending(null);
    }
  }

  const running = RUNNING.has(detail?.state ?? container.state);
  const shell = guessShell(detail?.image ?? container.image);
  const execCmd = `docker exec -it ${detail?.name || container.name || container.id.slice(0, 12)} ${shell}`;

  const publishedPorts = (detail?.ports ?? container.ports).filter((p) => p.publicPort);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--detail" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal__head">
          <h3>
            <span className={`dot dot--${running ? 'up' : 'down'}`} />
            {detail?.name || container.name || container.id.slice(0, 12)}
          </h3>
          <button className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {loadError && <p className="usage__error">⚠ {loadError}</p>}

        {/* Overview */}
        <section className="detail-section">
          <h4 className="detail-section__title">Overview</h4>
          <dl className="detail-kv">
            <div>
              <dt>ID</dt>
              <dd className="mono">{container.id.slice(0, 12)}</dd>
            </div>
            <div>
              <dt>Image</dt>
              <dd className="mono muted">{detail?.image || container.image}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>
                <span className={`state state--${running ? 'up' : 'down'}`}>
                  {detail?.state || container.state}
                </span>
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd className="muted">{detail?.status || container.status}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd className="muted">{timeAgo(detail?.created ?? container.created)}</dd>
            </div>
            <div>
              <dt>Disk (rw)</dt>
              <dd className="mono">{bytes(detail?.sizeRw ?? container.sizeRw)}</dd>
            </div>
            <div>
              <dt>Restart policy</dt>
              <dd className="mono">{detail?.restartPolicy ?? '—'}</dd>
            </div>
          </dl>
        </section>

        {/* Configuration */}
        <section className="detail-section">
          <h4 className="detail-section__title">Configuration</h4>

          <h5 className="detail-subtitle">Port mappings</h5>
          {publishedPorts.length === 0 ? (
            <p className="muted empty-sm">No published ports.</p>
          ) : (
            <dl className="detail-kv">
              {publishedPorts.map((p) => (
                <div key={`${p.privatePort}-${p.publicPort}`}>
                  <dt>{p.publicPort} → {p.privatePort}/{p.type}</dt>
                  <dd className="mono muted">host → container</dd>
                </div>
              ))}
            </dl>
          )}

          <h5 className="detail-subtitle">Environment</h5>
          {(detail?.env ?? []).length === 0 ? (
            <p className="muted empty-sm">No environment variables set.</p>
          ) : (
            <div className="env-list">
              {detail!.env.map((e) => {
                const [key, ...rest] = e.split('=');
                return (
                  <div className="env-row-detail" key={key}>
                    <code>{key}</code>
                    <span className="mono muted">{rest.join('=') || '(empty)'}</span>
                  </div>
                );
              })}
            </div>
          )}

          <h5 className="detail-subtitle">Volumes</h5>
          {(detail?.volumes ?? []).length === 0 ? (
            <p className="muted empty-sm">No volumes mounted.</p>
          ) : (
            <dl className="detail-kv">
              {detail!.volumes.map((v, i) => (
                <div key={i}>
                  <dt className="mono">{v.destination}</dt>
                  <dd className="mono muted">
                    {v.type} — {v.source} ({v.mode})
                  </dd>
                </div>
              ))}
            </dl>
          )}

          <h5 className="detail-subtitle">Labels</h5>
          {Object.keys(detail?.labels ?? {}).length === 0 ? (
            <p className="muted empty-sm">No labels.</p>
          ) : (
            <dl className="detail-kv">
              {Object.entries(detail!.labels).map(([k, v]) => (
                <div key={k}>
                  <dt className="mono">{k}</dt>
                  <dd className="mono muted">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        {/* Connect */}
        <section className="detail-section">
          <h4 className="detail-section__title">Connect</h4>

          <h5 className="detail-subtitle">Shell access</h5>
          <div className="cmd-block">
            <code className="cmd-block__text">{execCmd}</code>
            <button
              className="btn btn--sm"
              onClick={() => {
                navigator.clipboard.writeText(execCmd).catch(() => {
                  /* ignore */
                });
              }}
            >
              Copy
            </button>
          </div>
          <p className="muted hint">
            Run this in a terminal on the Docker host to get a shell inside the container.
          </p>

          <h5 className="detail-subtitle">Network</h5>
          {publishedPorts.length === 0 ? (
            <p className="muted empty-sm">No published ports — use <code>docker exec</code> above to reach this container.</p>
          ) : (
            <ul className="port-urls">
              {publishedPorts.map((p) => (
                <li key={`${p.privatePort}-${p.publicPort}`}>
                  <code>http://localhost:{p.publicPort}</code>
                  <span className="muted"> → container {p.privatePort}/{p.type}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Actions */}
        <section className="detail-section">
          <h4 className="detail-section__title">Actions</h4>
          <div className="detail-actions">
            {running ? (
              <button
                className="btn"
                disabled={pending === container.id}
                onClick={() => run(container.id, () => api.action(container.id, 'stop'))}
              >
                Stop
              </button>
            ) : (
              <button
                className="btn"
                disabled={pending === container.id}
                onClick={() => run(container.id, () => api.action(container.id, 'start'))}
              >
                Start
              </button>
            )}
            <button
              className="btn"
              disabled={pending === container.id}
              onClick={() => run(container.id, () => api.action(container.id, 'restart'))}
            >
              Restart
            </button>
            <button
              className="btn btn--primary"
              disabled={pending === container.id || !detail}
              title="Remove and re-create with new settings (e.g. different ports)"
              onClick={() => {
                if (detail) onRelaunch(detail);
              }}
            >
              Relaunch…
            </button>
            <button
              className="btn btn--danger"
              disabled={pending === container.id}
              onClick={() => {
                const name = detail?.name || container.name || container.id.slice(0, 12);
                if (confirm(`Remove ${name}?`))
                  run(container.id, () => api.remove(container.id, true)).then(() => onClose());
              }}
            >
              Remove
            </button>
          </div>
        </section>

        {/* Logs */}
        <section className="detail-section">
          <div className="detail-section__head">
            <h4 className="detail-section__title">Logs</h4>
            <button className="btn btn--sm" disabled={logsLoading} onClick={loadLogs}>
              {logsLoading ? 'Loading…' : logText ? 'Refresh' : 'Load logs'}
            </button>
          </div>
          {logText && <pre className="logs">{logText}</pre>}
        </section>
      </div>
    </div>
  );
}
