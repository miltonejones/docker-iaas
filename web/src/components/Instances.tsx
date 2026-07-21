import { useState, Fragment } from 'react';
import type { Container } from '../types';
import { bytes, timeAgo } from '../format';
import { api } from '../api';
import { AppIcon, PresetIcon } from '../icons';

interface Props {
  containers: Container[];
  busy: boolean;
  onChanged: () => void;
  onSelect: (c: Container) => void;
  onNewInstance?: () => void;
}

const RUNNING = new Set(['running', 'restarting']);
const VIEW_KEY = 'instances-view';
type ViewMode = 'list' | 'grid';

function loadView(): ViewMode {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    return saved === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

export function Instances({ containers, busy, onChanged, onSelect, onNewInstance }: Props) {
  const [pending, setPending] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<Container | null>(null);
  const [logText, setLogText] = useState<string>('');
  const [view, setView] = useState<ViewMode>(loadView);

  function changeView(next: ViewMode) {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* ignore storage errors (e.g. private browsing) */
    }
  }

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
        <div className="panel__head-actions">
          <div className="view-toggle" role="group" aria-label="View mode">
            <button
              className={`view-toggle__btn ${view === 'list' ? 'view-toggle__btn--on' : ''}`}
              onClick={() => changeView('list')}
              title="List view"
              aria-pressed={view === 'list'}
            >
              <AppIcon name="menu" />
            </button>
            <button
              className={`view-toggle__btn ${view === 'grid' ? 'view-toggle__btn--on' : ''}`}
              onClick={() => changeView('grid')}
              title="Grid view"
              aria-pressed={view === 'grid'}
            >
              <AppIcon name="container" />
            </button>
          </div>
          {onNewInstance && (
            <button className="btn btn--primary btn--sm" onClick={onNewInstance}>
              + New instance
            </button>
          )}
        </div>
      </div>

      {containers.length === 0 ? (
        <p className="empty">No instances yet.</p>
      ) : view === 'grid' ? (
        <div className="instance-grid">
          {containers.map((c) => {
            const running = RUNNING.has(c.state);
            const isPending = pending === c.id || busy;
            const systemLocked = !!c.system;
            const locked = systemLocked || !!c.protected;
            return (
              <article className="card glow instance-card" key={c.id}>
                <div className="card__icon" aria-hidden>
                  <PresetIcon id={c.presetId || ''} />
                </div>
                <div className="card__body">
                  <h3>
                    <button
                      className="instance-link"
                      onClick={() => onSelect(c)}
                      title="View details"
                    >
                      {c.name || c.id.slice(0, 12)}
                    </button>
                  </h3>
                  <p className="card__desc">{c.description || c.image}</p>
                  <div className="instance-card__status">
                    <span className={`dot dot--${running ? 'up' : 'down'}`} />
                    <span className={`state state--${running ? 'up' : 'down'}`}>{c.state}</span>
                    <span className="muted instance-card__age">{timeAgo(c.created)}</span>
                  </div>
                  <div className="card__meta">
                    <code title={c.image}>{c.image}</code>
                    <span className="card__size">{bytes(c.sizeRw)}</span>
                  </div>
                  {c.ports.some((p) => p.publicPort) && (
                    <div className="mono muted instance-card__ports">
                      {c.ports
                        .filter((p) => p.publicPort)
                        .map((p) => `${p.publicPort}→${p.privatePort}`)
                        .join(', ')}
                    </div>
                  )}
                </div>
                <div className="instance-card__actions">
                  {running ? (
                    <button
                      className="btn btn--sm"
                      disabled={isPending || locked}
                      title={systemLocked ? "System-managed — can't be stopped here" : locked ? "Protected — can't be stopped here" : undefined}
                      onClick={() => run(c.id, () => api.action(c.id, 'stop'))}
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      className="btn btn--sm"
                      disabled={isPending || locked}
                      title={systemLocked ? "System-managed — can't be started here" : locked ? "Protected — can't be started here" : undefined}
                      onClick={() => run(c.id, () => api.action(c.id, 'start'))}
                    >
                      Start
                    </button>
                  )}
                  <button
                    className="btn btn--sm"
                    disabled={isPending || locked}
                    title={systemLocked ? "System-managed — can't be restarted here" : locked ? "Protected — can't be restarted here" : undefined}
                    onClick={() => run(c.id, () => api.action(c.id, 'restart'))}
                  >
                    Restart
                  </button>
                  <button className="btn btn--sm" onClick={() => showLogs(c)}>
                    Logs
                  </button>
                  {locked ? (
                    <span className="chip" title={systemLocked ? "System-managed — can't be removed here" : "Protected — can't be removed here"}>
                      Protected
                    </span>
                  ) : (
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
                  )}
                </div>
              </article>
            );
          })}
        </div>
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
                const systemLocked = !!c.system;
                const locked = systemLocked || !!c.protected;
                return (
                  <Fragment key={c.id}>
                  <tr>
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
                    <td className="mono muted truncate" title={c.image}>{c.image}</td>
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
                          disabled={isPending || locked}
                          title={systemLocked ? "System-managed — can't be stopped here" : locked ? "Protected — can't be stopped here" : undefined}
                          onClick={() => run(c.id, () => api.action(c.id, 'stop'))}
                        >
                          Stop
                        </button>
                      ) : (
                        <button
                          className="btn btn--sm"
                          disabled={isPending || locked}
                          title={systemLocked ? "System-managed — can't be started here" : locked ? "Protected — can't be started here" : undefined}
                          onClick={() => run(c.id, () => api.action(c.id, 'start'))}
                        >
                          Start
                        </button>
                      )}
                      <button
                        className="btn btn--sm"
                        disabled={isPending || locked}
                        title={systemLocked ? "System-managed — can't be restarted here" : locked ? "Protected — can't be restarted here" : undefined}
                        onClick={() => run(c.id, () => api.action(c.id, 'restart'))}
                      >
                        Restart
                      </button>
                      <button className="btn btn--sm" onClick={() => showLogs(c)}>
                        Logs
                      </button>
                      {locked ? (
                        <span className="chip" title={systemLocked ? "System-managed — can't be removed here" : "Protected — can't be removed here"}>
                          Protected
                        </span>
                      ) : (
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
                      )}
                    </td>
                  </tr>
                  {c.description && (
                    <tr className="instance-desc-row">
                      <td colSpan={7} className="muted instance-desc">
                        {c.description}
                      </td>
                    </tr>
                  )}
                  </Fragment>
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
