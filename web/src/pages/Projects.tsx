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
    <div>
      <div className="panel__head">
        <h2>Projects</h2>
        <button className="btn btn--primary btn--sm" onClick={() => setCreating(!creating)}>
          {creating ? 'Cancel' : '+ New Project'}
        </button>
      </div>

      {creating && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
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
          </div>
        </div>
      )}

      {loading && <p className="muted empty">Loading…</p>}

      {!loading && projects.length === 0 && (
        <p className="muted empty">No projects yet. Create one to group your resources.</p>
      )}

      <div className="home-cards">
        {projects.map((p) => (
          <button key={p.id} className="home-card glow" onClick={() => navigate(`/projects/${p.id}`)}>
            <span className="home-card__num" style={{ fontSize: 18 }}>
              {p.name}
            </span>
            {p.description && (
              <span className="home-card__label">{p.description}</span>
            )}
            <div style={{ display: 'flex', gap: 12, fontSize: 12, marginTop: 4 }}>
              <span><AppIcon name="container" /> {p.summary.containers}</span>
              <span><AppIcon name="function" /> {p.summary.functions}</span>
              <span><AppIcon name="bucket" /> {p.summary.buckets}</span>
              <span><AppIcon name="gateway" /> {p.summary.routes}</span>
              <span><AppIcon name="database" /> {p.summary.databases}</span>
            </div>
            <button
              className="btn btn--ghost btn--sm"
              style={{ marginTop: 4 }}
              onClick={(e) => { e.stopPropagation(); deleteProject(p.id, p.name); }}
              title="Delete project"
            >
              ×
            </button>
          </button>
        ))}
      </div>
    </div>
  );
}
