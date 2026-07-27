import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ProjectDetail } from '../types';
import { api } from '../api';
import { AppIcon } from '../icons';
import { onRefresh } from '../refresh';

export function ProjectsPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');

  function load() {
    setLoading(true);
    api.projectList()
      .then(setProjects)
      .catch(console.error)
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);
  useEffect(() => onRefresh(load), []);

  async function create() {
    const name = newName.trim();
    if (!name) return;
    try {
      const proj = await api.projectCreate(name, newDescription.trim() || undefined);
      setProjects((prev) => [proj, ...prev]);
      setNewName('');
      setNewDescription('');
      setCreating(false);
    } catch (err) {
      console.error('create project', err);
    }
  }

  async function deleteProject(id: string, name: string) {
    if (!confirm(`Delete project "${name}"? Resources will be unlinked but not deleted.`)) return;
    try {
      await api.projectDelete(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      console.error('delete project', err);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Projects <span className="count">{projects.length}</span></h2>
        <button className="btn btn--primary btn--sm" onClick={() => setCreating(!creating)}>
          <AppIcon name="plus" />
        </button>
      </div>

      {creating && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
          <input
            className="input"
            placeholder="Project name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            autoFocus
            style={{ flex: 1 }}
          />
          <input
            className="input"
            placeholder="Description (optional)"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            style={{ flex: 2 }}
          />
          <button className="btn btn--primary" onClick={create}>Create</button>
          <button className="btn btn--ghost" onClick={() => { setCreating(false); setNewName(''); setNewDescription(''); }}>Cancel</button>
        </div>
      )}

      {loading && <p className="muted empty">Loading…</p>}

      {!loading && projects.length === 0 && (
        <p className="muted empty">No projects yet. Create one to group your resources.</p>
      )}

      {!loading && projects.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Resources</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} onClick={() => navigate(`/projects/${p.id}`)}>
                  <td>
                    <div style={{ fontWeight: 500 }}><AppIcon name="project" /> {p.name}</div>
                    {p.description && (
                      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{p.description}</div>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 10, fontSize: 13 }}>
                      <span title="Containers"><AppIcon name="container" /> {p.summary?.containers ?? 0}</span>
                      <span title="Functions"><AppIcon name="function" /> {p.summary?.functions ?? 0}</span>
                      <span title="Buckets"><AppIcon name="bucket" /> {p.summary?.buckets ?? 0}</span>
                      <span title="Routes"><AppIcon name="gateway" /> {p.summary?.routes ?? 0}</span>
                      <span title="Databases"><AppIcon name="database" /> {p.summary?.databases ?? 0}</span>
                    </div>
                  </td>
                  <td className="muted">{new Date(p.createdAt).toLocaleDateString()}</td>
                  <td>
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={(e) => { e.stopPropagation(); deleteProject(p.id, p.name); }}
                      title="Delete project"
                    >
                      ×
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
