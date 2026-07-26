import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import type { ProjectDetail, Container, LambdaFunction, GatewayRoute, Bucket, DatabaseConnectionDetail } from '../types';
import { api } from '../api';
import { AppIcon } from '../icons';
import { timeAgo } from '../format';
import { onRefresh } from '../refresh';

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [containers, setContainers] = useState<Container[]>([]);
  const [functions, setFunctions] = useState<LambdaFunction[]>([]);
  const [routes, setRoutes] = useState<GatewayRoute[]>([]);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [dbs, setDbs] = useState<DatabaseConnectionDetail[]>([]);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');

  function load() {
    if (!id) return;
    api.projectGet(id).then((p) => {
      setProject(p);
      setEditName(p.name);
      setEditDesc(p.description || '');
    }).catch(() => navigate('/projects'));

    // Load resources filtered by this project.
    Promise.allSettled([
      api.containers().then((list) => setContainers(list.filter((c) => c.projectId === id))),
      api.lambdaListFunctions().then((list) => setFunctions(list.filter((f) => f.projectId === id))),
      api.gatewayList().then((list) => setRoutes(list.filter((r) => r.projectId === id))),
      api.bucketList().then((list) => setBuckets(list.filter((b) => b.projectId === id))),
      api.databaseConnections().then((list) => setDbs(list.filter((d) => d.projectId === id))),
    ]).catch(console.error);
  }

  useEffect(() => { load(); }, [id]);
  useEffect(() => onRefresh(load), []);

  if (!project || !id) return <p className="muted empty">Loading…</p>;

  const totalResources = containers.length + functions.length + routes.length + buckets.length + dbs.length;

  return (
    <div>
      <div className="panel__head">
        <div>
          <h2>
            <AppIcon name="project" /> {project.name}
          </h2>
          {project.description && !editing && (
            <p className="muted" style={{ marginTop: 4 }}>{project.description}</p>
          )}
          {editing && (
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <input
                className="input"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Project name"
                style={{ flex: 1 }}
              />
              <input
                className="input"
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder="Description"
                style={{ flex: 2 }}
              />
              <button
                className="btn btn--primary btn--sm"
                onClick={async () => {
                  try {
                    const updated = await api.projectUpdate(id, { name: editName, description: editDesc });
                    setProject(updated);
                    setEditing(false);
                  } catch (err) { console.error(err); }
                }}
              >
                Save
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn--ghost btn--sm" onClick={() => setEditing(!editing)}>
            <AppIcon name="edit" /> Edit
          </button>
        </div>
      </div>

      <div className="home-cards" style={{ marginBottom: 16 }}>
        <div className="home-card">
          <span className="home-card__num">{totalResources}</span>
          <span className="home-card__label">Total resources</span>
        </div>
        <Link to={`/containers?projectId=${encodeURIComponent(id)}`} className="home-card glow">
          <span className="home-card__num">{containers.length}</span>
          <span className="home-card__label">Containers</span>
        </Link>
        <Link to={`/functions?projectId=${encodeURIComponent(id)}`} className="home-card glow">
          <span className="home-card__num">{functions.length}</span>
          <span className="home-card__label">Functions</span>
        </Link>
        <Link to={`/gateway?projectId=${encodeURIComponent(id)}`} className="home-card glow">
          <span className="home-card__num">{routes.length}</span>
          <span className="home-card__label">Routes</span>
        </Link>
        <div className="home-card">
          <span className="home-card__num">{buckets.length}</span>
          <span className="home-card__label">Buckets</span>
        </div>
        <Link to={`/databases?projectId=${encodeURIComponent(id)}`} className="home-card glow">
          <span className="home-card__num">{dbs.length}</span>
          <span className="home-card__label">Databases</span>
        </Link>
      </div>

      {/* Resource lists */}
      {totalResources === 0 && (
        <p className="muted empty">
          No resources in this project yet. Assign resources by selecting this project when creating them,
          or use the Ask Dockyard assistant.
        </p>
      )}

      {containers.length > 0 && (
        <section className="panel">
          <div className="panel__head">
            <h3><AppIcon name="container" /> Containers <span className="count">{containers.length}</span></h3>
          </div>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {containers.map((c) => (
                  <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/containers/${c.id}`)}>
                    <td><AppIcon name="container" /> <strong>{c.name}</strong></td>
                    <td className="mono muted">{c.image}</td>
                    <td>
                      <span className={`badge badge--${c.state === 'running' ? 'ok' : 'warn'}`}>
                        {c.state}
                      </span>
                    </td>
                    <td className="muted">{c.description || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {functions.length > 0 && (
        <section className="panel">
          <div className="panel__head">
            <h3><AppIcon name="function" /> Functions <span className="count">{functions.length}</span></h3>
          </div>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {functions.map((f) => (
                  <tr key={f.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/functions/${f.id}`)}>
                    <td><AppIcon name="function" /> <strong>{f.name}</strong></td>
                    <td className="muted">{f.runtime}</td>
                    <td className="muted">{timeAgo(new Date(f.updatedAt).getTime() / 1000)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {routes.length > 0 && (
        <section className="panel">
          <div className="panel__head">
            <h3><AppIcon name="gateway" /> Gateway Routes <span className="count">{routes.length}</span></h3>
          </div>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {routes.map((r) => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/gateway/${r.name}`)}>
                    <td><AppIcon name="gateway" /> <strong>{r.displayName || r.name}</strong></td>
                    <td className="muted">{r.targetType}</td>
                    <td className="mono muted">
                      <a href={`/gw/${r.name}/`} target="_blank" rel="noreferrer">
                        /gw/{r.name}/ <AppIcon name="external" />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {dbs.length > 0 && (
        <section className="panel">
          <div className="panel__head">
            <h3><AppIcon name="database" /> Databases <span className="count">{dbs.length}</span></h3>
          </div>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {dbs.map((db) => (
                  <tr key={db.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/databases/${db.id}`)}>
                    <td><AppIcon name="database" /> <strong>{db.name}</strong></td>
                    <td className="muted">{db.engine}</td>
                    <td className="muted">
                      {db.lastTestStatus === 'ok' ? (
                        <span className="badge badge--ok">Connected</span>
                      ) : db.lastTestStatus ? (
                        <span className="badge badge--warn">Error</span>
                      ) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
