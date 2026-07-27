import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { Project } from '../types';
import { AppIcon } from '../icons';

interface Props {
  value: string | null;
  onChange: (projectId: string | null) => void;
}

const STORAGE_KEY = 'dockyard:selected-project';

export function getStoredProjectId(): string | null {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

export function ProjectSelector({ value, onChange }: Props) {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.projectList().then(setProjects).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const selected = value ? projects.find((p) => p.id === value) : null;

  function select(id: string | null) {
    onChange(id);
    try { if (id) localStorage.setItem(STORAGE_KEY, id); else localStorage.removeItem(STORAGE_KEY); } catch {}
    setOpen(false);
    if (id) navigate(`/projects/${id}`);
  }

  async function create() {
    const name = newName.trim();
    if (!name) return;
    try {
      const proj = await api.projectCreate(name);
      setProjects((prev) => [proj, ...prev]);
      select(proj.id);
      setNewName('');
      setCreating(false);
    } catch (err) {
      console.error('create project', err);
    }
  }

  return (
    <div className="project-selector" ref={ref}>
      <button
        className="project-selector__btn"
        onClick={() => { setOpen(!open); if (!open) { api.projectList().then(setProjects).catch(() => {}); } }}
        title={selected ? `Project: ${selected.name}` : 'All projects'}
      >
        <AppIcon name="project" />
        <span className="project-selector__label">
          {selected ? selected.name : 'All'}
        </span>
        <span className="project-selector__chevron">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="project-selector__menu">
          <button
            className={`project-selector__item${!value ? ' project-selector__item--active' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); select(null); }}
          >
            <AppIcon name="project" /> All Projects
          </button>
          {projects.map((p) => (
            <button
              key={p.id}
              className={`project-selector__item${p.id === value ? ' project-selector__item--active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); select(p.id); }}
            >
              <AppIcon name="project" /> {p.name}
            </button>
          ))}
          <div className="project-selector__divider" />
          {creating ? (
            <div className="project-selector__create-form">
              <input
                className="input"
                placeholder="Project name…"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') create();
                  if (e.key === 'Escape') { setCreating(false); setNewName(''); }
                }}
                autoFocus
              />
              <button className="btn btn--primary btn--sm" onClick={create}>
                Create
              </button>
            </div>
          ) : (
            <button
              className="project-selector__item project-selector__item--new"
              onClick={() => setCreating(true)}
            >
              + New Project
            </button>
          )}
        </div>
      )}
    </div>
  );
}
