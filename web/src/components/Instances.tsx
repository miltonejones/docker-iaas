import { useState } from 'react';
import type { Container } from '../types';
import { bytes, timeAgo } from '../format';
import { api } from '../api';

interface Props {
  containers: Container[];
  busy: boolean;
  onChanged: () => void;
  onSelect: (c: Container) => void;
}

const RUNNING = new Set(['running', 'restarting']);

export function Instances({ containers, busy, onChanged, onSelect }: Props) {
  const [pending, setPending] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<Container | null>(null);
  const [logText, setLogText] = useState<string>('');

  async function run(id: string, fn: () => Promise<unknown>) {
    setPending(id);
    try {
      await fn();
      onChanged();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setPending(null);
    }
  }

  async function showLogs(c: Container) {
    setLogsFor(c);
    setLogText('Loading…');
    try {
      setLogText((await api.logs(c.id)) || '(no output)');
    } catch (err) {
      setLogText((err as Error).message);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>
          Instances <span className="count">{containers.length}</span>
        </h2>
      </div>

      {containers.length === 0 ? (
        <p className="empty">No instances yet. Launch one from the gallery above.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Instance</th>
                <th>Image</th>
                <th>State</th>
                <th>Ports</th>
                <th className="num">Disk (rw)</th>
                <th>Age</th>
                <th className="actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {containers.map((c) => {
                const running = RUNNING.has(c.state);
                const isPending = pending === c.id || busy;
                return (
                  <tr key={c.id}>
                    <td>
                      <span className={`dot dot--${running ? 'up' : 'down'}`} />
                      <button
                        className="instance-link"
                        onClick={() => onSelect(c)}
                        title="View details"
                      >
                        {c.name || c.id.slice(0, 12)}
                      </button>
                    </td>
                    <td className="mono muted">{c.image}</td>
                    <td>
                      <span className={`state state--${running ? 'up' : 'down'}`}>{c.state}</span>
                    </td>
                    <td className="mono muted">
                      {c.ports
                        .filter((p) => p.publicPort)
                        .map((p) => `${p.publicPort}→${p.privatePort}`)
                        .join(', ') || '—'}
                    </td>
                    <td className="num mono">{bytes(c.sizeRw)}</td>
                    <td className="muted">{timeAgo(c.created)}</td>
                    <td className="actions-col">
                      {running ? (
                        <button
                          className="btn btn--sm"
                          disabled={isPending}
                          onClick={() => run(c.id, () => api.action(c.id, 'stop'))}
                        >
                          Stop
                        </button>
                      ) : (
                        <button
                          className="btn btn--sm"
                          disabled={isPending}
                          onClick={() => run(c.id, () => api.action(c.id, 'start'))}
                        >
                          Start
                        </button>
                      )}
                      <button
                        className="btn btn--sm"
                        disabled={isPending}
                        onClick={() => run(c.id, () => api.action(c.id, 'restart'))}
                      >
                        Restart
                      </button>
                      <button className="btn btn--sm" onClick={() => showLogs(c)}>
                        Logs
                      </button>
                      <button
                        className="btn btn--sm btn--danger"
                        disabled={isPending}
                        onClick={() => {
                          if (confirm(`Remove ${c.name || c.id.slice(0, 12)}?`))
                            run(c.id, () => api.remove(c.id, true));
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {logsFor && (
        <div className="modal-backdrop" onClick={() => setLogsFor(null)}>
          <div className="modal modal--logs" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head">
              <h3>Logs · {logsFor.name || logsFor.id.slice(0, 12)}</h3>
              <button className="btn btn--ghost" onClick={() => setLogsFor(null)}>
                Close
              </button>
            </div>
            <pre className="logs">{logText}</pre>
          </div>
        </div>
      )}
    </section>
  );
}
