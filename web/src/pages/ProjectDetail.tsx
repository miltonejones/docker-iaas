import { useEffect, useState, useMemo } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import type {
  ProjectDetail, Container, LambdaFunction, GatewayRoute, Bucket, DatabaseConnectionDetail,
  ProjectManifest, ManifestDrift, ManifestSection,
} from '../types';
import { api } from '../api';
import { AppIcon } from '../icons';
import { timeAgo } from '../format';
import { onRefresh } from '../refresh';
import { emitOpenAssistant } from '../assistant';
import { useAuth } from '../AuthContext';
import { useToast } from '../ToastContext';

type Resource =
  | { kind: 'container'; data: Container }
  | { kind: 'function'; data: LambdaFunction }
  | { kind: 'route'; data: GatewayRoute }
  | { kind: 'bucket'; data: Bucket }
  | { kind: 'database'; data: DatabaseConnectionDetail };

interface UnassignedResource {
  kind: Resource['kind'];
  id: string;
  name: string;
  subtitle: string;
}

const KIND_LABEL: Record<Resource['kind'], string> = {
  container: 'Containers',
  function: 'Functions',
  route: 'Routes',
  bucket: 'Buckets',
  database: 'Databases',
};

const KIND_ICON: Record<Resource['kind'], string> = {
  container: 'container',
  function: 'function',
  route: 'gateway',
  bucket: 'bucket',
  database: 'database',
};

const KIND_TO_SECTION: Record<Resource['kind'], ManifestSection> = {
  container: 'containers',
  function: 'functions',
  route: 'routes',
  bucket: 'buckets',
  database: 'databases',
};

function driftStatus(
  manifest: ProjectManifest | null,
  drift: ManifestDrift | null,
  kind: Resource['kind'],
  id: string,
): 'synced' | 'changed' | 'orphaned' | null {
  if (!manifest || !drift) return null;
  const section = KIND_TO_SECTION[kind];
  if (drift.orphaned.some((o) => o.kind === section && o.id === id)) return 'orphaned';
  const ref = Object.entries(manifest[section] || {}).find(([, v]) => v.id === id)?.[0];
  if (!ref) return null;
  if (drift.changed.some((c) => c.kind === section && c.ref === ref)) return 'changed';
  if (drift.synced.includes(ref)) return 'synced';
  return null;
}

function isProtectedResource(manifest: ProjectManifest | null, kind: Resource['kind'], id: string): boolean {
  if (!manifest) return false;
  const section = KIND_TO_SECTION[kind];
  return Object.values(manifest[section] || {}).some((v) => v.id === id);
}

const DRIFT_BADGE: Record<'synced' | 'changed' | 'orphaned', { icon: string; title: string }> = {
  synced: { icon: '🟢', title: 'Matches captured manifest' },
  changed: { icon: '🟡', title: 'Configuration differs from captured manifest' },
  orphaned: { icon: '⚪', title: 'Linked to project but not in captured manifest' },
};

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [containers, setContainers] = useState<Container[]>([]);
  const [functions, setFunctions] = useState<LambdaFunction[]>([]);
  const [routes, setRoutes] = useState<GatewayRoute[]>([]);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [dbs, setDbs] = useState<DatabaseConnectionDetail[]>([]);
  const [selected, setSelected] = useState<Resource | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);
  const [drift, setDrift] = useState<ManifestDrift | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [showManifest, setShowManifest] = useState(false);
  const { role } = useAuth();
  const toast = useToast();

  // Track which resource groups are collapsed in the left pane.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggleCollapse(kind: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      return next;
    });
  }

  function load() {
    if (!id) return;
    api.projectGet(id).then((p) => {
      setProject(p);
      setEditName(p.name);
      setEditDesc(p.description || '');
    }).catch(() => navigate('/projects'));

    Promise.allSettled([
      api.containers().then(setContainers),
      api.lambdaListFunctions().then(setFunctions),
      api.gatewayList().then(setRoutes),
      api.bucketList().then(setBuckets),
      api.databaseConnections().then(setDbs),
    ]).catch(console.error);

    api.projectGetManifest(id).then(setManifest).catch(() => setManifest(null));
    api.projectGetManifestDrift(id).then(setDrift).catch(() => setDrift(null));
  }

  useEffect(() => { load(); }, [id]);
  useEffect(() => onRefresh(load), []);

  async function captureManifest() {
    if (!id) return;
    setCapturing(true);
    try {
      const captured = await api.projectCaptureManifest(id);
      setManifest(captured);
      const nextDrift = await api.projectGetManifestDrift(id);
      setDrift(nextDrift);
      toast.success('Manifest captured.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to capture manifest.');
    } finally {
      setCapturing(false);
    }
  }

  // All hooks must run unconditionally (React hook rules).
  const pid = (project && id) ? id : null;

  const projectResources: Resource[] = useMemo(() => {
    if (!pid) return [];
    return [
      ...containers.filter((c) => c.projectId === pid).map((c) => ({ kind: 'container' as const, data: c })),
      ...functions.filter((f) => f.projectId === pid).map((f) => ({ kind: 'function' as const, data: f })),
      ...routes.filter((r) => r.projectId === pid).map((r) => ({ kind: 'route' as const, data: r })),
      ...buckets.filter((b) => b.projectId === pid).map((b) => ({ kind: 'bucket' as const, data: b })),
      ...dbs.filter((db) => db.projectId === pid).map((db) => ({ kind: 'database' as const, data: db })),
    ];
  }, [containers, functions, routes, buckets, dbs, pid]);

  const resourcesByKind = useMemo(() => {
    const map = new Map<Resource['kind'], Resource[]>();
    for (const k of ['container', 'function', 'route', 'bucket', 'database'] as const) map.set(k, []);
    for (const r of projectResources) map.get(r.kind)!.push(r);
    return map;
  }, [projectResources]);

  // Unassigned resources for add mode.
  const unassigned: UnassignedResource[] = useMemo(() => {
    const out: UnassignedResource[] = [];
    for (const c of containers) {
      if (!c.projectId || c.projectId !== id) {
        out.push({ kind: 'container', id: c.id, name: c.name, subtitle: c.image });
      }
    }
    for (const f of functions) {
      if (!f.projectId || f.projectId !== id) {
        out.push({ kind: 'function', id: f.id, name: f.name, subtitle: f.runtime });
      }
    }
    for (const r of routes) {
      if (!r.projectId || r.projectId !== id) {
        out.push({ kind: 'route', id: r.id, name: r.displayName || r.name, subtitle: r.targetType });
      }
    }
    for (const b of buckets) {
      if (!b.projectId || b.projectId !== id) {
        out.push({ kind: 'bucket', id: b.name, name: b.name, subtitle: `${b.objectCount ?? 0} objects` });
      }
    }
    for (const d of dbs) {
      if (!d.projectId || d.projectId !== id) {
        out.push({ kind: 'database', id: d.id, name: d.name, subtitle: d.engine });
      }
    }
    return out;
  }, [containers, functions, routes, buckets, dbs, id]);

  const filteredUnassigned = useMemo(() => {
    if (!search.trim()) return unassigned;
    const q = search.toLowerCase();
    return unassigned.filter((r) => r.name.toLowerCase().includes(q) || r.subtitle.toLowerCase().includes(q));
  }, [unassigned, search]);

  const unassignedByKind = useMemo(() => {
    const map = new Map<Resource['kind'], UnassignedResource[]>();
    for (const k of ['container', 'function', 'route', 'bucket', 'database'] as const) map.set(k, []);
    for (const r of filteredUnassigned) map.get(r.kind)!.push(r);
    return map;
  }, [filteredUnassigned]);

  // ── Early return after all hooks ──────────────────────────
  if (!project || !pid) return <p className="muted empty">Loading…</p>;

  async function removeResource(r: Resource) {
    try {
      if (r.kind === 'container') {
        await api.containerUpdateEnv(r.data.id, undefined, undefined, undefined, undefined, null);
      } else {
        const tableMap: Record<string, string> = {
          container: '',
          function: 'functions',
          route: 'routes',
          bucket: 'bucket_owners',
          database: 'database_connections',
        };
        const resourceId: string = r.kind === 'bucket' ? r.data.name : (r.data as any).id;
        await api.projectRemoveResource(pid!, tableMap[r.kind]!, resourceId);
      }
      load();
      if (selected && getResourceId(selected) === getResourceId(r)) setSelected(null);
    } catch (err) {
      console.error('remove resource', err);
    }
  }

  async function addResource(r: UnassignedResource) {
    try {
      if (r.kind === 'container') {
        await api.containerUpdateEnv(r.id, undefined, undefined, undefined, undefined, pid!);
      } else {
        const tableMap: Record<string, string> = {
          container: '',
          function: 'functions',
          route: 'routes',
          bucket: 'bucket_owners',
          database: 'database_connections',
        };
        await api.projectAddResource(pid!, tableMap[r.kind]!, r.id as string);
      }
      load();
      setAddMode(false);
      setSearch('');
    } catch (err) {
      console.error('add resource', err);
    }
  }

  function selectResource(r: Resource) {
    setSelected(r);
    setAddMode(false);
  }

  function getResourceId(r: Resource): string {
    return r.kind === 'bucket' ? r.data.name : (r.data as any).id;
  }

  function getResourceName(r: Resource): string {
    if (r.kind === 'container') return r.data.name;
    if (r.kind === 'function') return r.data.name;
    if (r.kind === 'route') return (r.data as GatewayRoute).pathPattern || (r.data as GatewayRoute).name;
    if (r.kind === 'bucket') return r.data.name;
    return r.data.name;
  }

  return (
    <div className="project-detail-layout">
      {/* ── Left pane: resource list ──────────────────────────── */}
      <aside className="project-detail__list">
        <div className="project-detail__list-head">
          <h3>
            <AppIcon name="project" /> {project.name}
          </h3>
          <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
            <button className="btn btn--primary btn--sm" onClick={() => { setAddMode(true); setSelected(null); setShowManifest(false); }}>
              + Add
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => setEditing(!editing)}>
              <AppIcon name="edit" />
            </button>
            <button className="btn btn--ghost btn--sm" onClick={captureManifest} disabled={capturing} title="Snapshot the resources currently linked to this project.">
              {capturing ? 'Capturing…' : 'Capture'}
            </button>
            {manifest && (
              <button className="btn btn--ghost btn--sm" onClick={() => { setShowManifest(true); setAddMode(false); setSelected(null); }}>
                Manifest
              </button>
            )}
          </div>
          {manifest && (
            <p className="muted" style={{ padding: '0 8px', fontSize: 11, marginTop: 4 }}>
              Captured {timeAgo(new Date(manifest.capturedAt).getTime() / 1000)}
            </p>
          )}
          {editing && (
            <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
              <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Name" style={{ flex: 1, fontSize: 12, padding: '4px 6px' }} />
              <input className="input" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="Description" style={{ flex: 2, fontSize: 12, padding: '4px 6px' }} />
              <button
                className="btn btn--primary btn--sm"
                onClick={async () => {
                  try {
                    const updated = await api.projectUpdate(pid!, { name: editName, description: editDesc });
                    setProject(updated);
                    setEditing(false);
                  } catch (err) { console.error(err); }
                }}
              >Save</button>
            </div>
          )}
        </div>
        {project.description && <p className="muted" style={{ padding: '0 8px', fontSize: 12 }}>{project.description}</p>}

        <div className="project-detail__list-body">
          {(['container', 'function', 'route', 'bucket', 'database'] as const).map((kind) => {
            const items = resourcesByKind.get(kind) || [];
            const isCollapsed = collapsed.has(kind);
            return (
              <div key={kind} className="project-detail__group">
                <button
                  className="project-detail__group-header"
                  onClick={() => toggleCollapse(kind)}
                >
                  <span>{isCollapsed ? '▸' : '▾'}</span>
                  <AppIcon name={KIND_ICON[kind]} />
                  <span>{KIND_LABEL[kind]}</span>
                  <span className="count">{items.length}</span>
                </button>
                {!isCollapsed && items.map((r) => {
                  const rid = getResourceId(r);
                  const isActive = selected && getResourceId(selected) === rid;
                  const status = driftStatus(manifest, drift, kind, rid);
                  const protectedResource = isProtectedResource(manifest, kind, rid);
                  return (
                    <div key={`${kind}-${rid}`} className={`project-detail__resource-row${isActive ? ' project-detail__resource-row--active' : ''}`}>
                      <button className="project-detail__resource-btn" onClick={() => selectResource(r)}>
                        <AppIcon name={KIND_ICON[kind]} />
                        <span className="project-detail__resource-name">{getResourceName(r)}</span>
                        {kind === 'container' && (
                          <span className={`badge badge--${(r as any).data.state === 'running' ? 'ok' : 'warn'} badge--xs`}>{(r as any).data.state}</span>
                        )}
                        {status && <span title={DRIFT_BADGE[status].title}>{DRIFT_BADGE[status].icon}</span>}
                        {protectedResource && role !== 'admin' && (
                          <span title={`Managed by project "${project.name}" — delete is blocked until unlinked`}>🔒</span>
                        )}
                      </button>
                      <button
                        className="btn btn--ghost btn--sm project-detail__remove-btn"
                        title="Remove from project"
                        onClick={() => removeResource(r)}
                      >×</button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </aside>

      {/* ── Right pane: detail or add mode ────────────────────── */}
      <main className="project-detail__main">
        {addMode ? (
          <div className="panel">
            <div className="panel__head">
              <h3>Add resources to {project.name}</h3>
              <button className="btn btn--ghost btn--sm" onClick={() => setAddMode(false)}>Cancel</button>
            </div>
            <div style={{ padding: '0 12px 8px' }}>
              <input
                className="input search-input"
                placeholder="Search resources…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
              />
            </div>
            <div className="project-detail__add-list">
              {(['container', 'function', 'route', 'bucket', 'database'] as const).map((kind) => {
                const items = unassignedByKind.get(kind) || [];
                if (items.length === 0) return null;
                return (
                  <div key={kind} style={{ marginBottom: 8 }}>
                    <div className="project-detail__group-header" style={{ cursor: 'default', padding: '4px 12px', fontSize: 12 }}>
                      <AppIcon name={KIND_ICON[kind]} /> {KIND_LABEL[kind]}
                    </div>
                    {items.map((r) => (
                      <div key={`${kind}-${r.id}`} className="project-detail__add-row">
                        <span style={{ flex: 1 }}>
                          <strong>{r.name}</strong>
                          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>{r.subtitle}</span>
                        </span>
                        <button className="btn btn--primary btn--sm" onClick={() => addResource(r)}>Add</button>
                      </div>
                    ))}
                  </div>
                );
              })}
              {filteredUnassigned.length === 0 && (
                <p className="muted empty">No unassigned resources found.</p>
              )}
            </div>
          </div>
        ) : showManifest && manifest ? (
          <ManifestPanel project={project} manifest={manifest} drift={drift} onClose={() => setShowManifest(false)} />
        ) : selected ? (
          <ResourceDetailPane resource={selected} onClose={() => setSelected(null)} />
        ) : (
          <div className="panel" style={{ textAlign: 'center', padding: 40 }}>
            <AppIcon name="project" />
            <p className="muted" style={{ marginTop: 8 }}>
              Select a resource from the list, or click <strong>+ Add</strong> to add resources.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

// ── Manifest panel ─────────────────────────────────────────────────────────

function ManifestPanel({
  project, manifest, drift, onClose,
}: { project: ProjectDetail; manifest: ProjectManifest; drift: ManifestDrift | null; onClose: () => void }) {
  const json = useMemo(() => JSON.stringify(manifest, null, 2), [manifest]);

  function download() {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name}-manifest.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="panel">
      <div className="panel__head">
        <h3>Manifest — {project.name}</h3>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="btn btn--ghost btn--sm" onClick={download}>Download</button>
          <button className="btn btn--ghost btn--sm" onClick={onClose}>×</button>
        </div>
      </div>
      <p className="muted" style={{ padding: '0 12px', fontSize: 12 }}>
        Captured {new Date(manifest.capturedAt).toLocaleString()}. Resources listed here cannot be deleted
        (or have their route target changed) by non-admin users until unlinked from this project.
      </p>
      {drift && (drift.missing.length > 0 || drift.changed.length > 0 || drift.orphaned.length > 0) && (
        <div style={{ padding: '0 12px 8px', fontSize: 12 }}>
          {drift.missing.length > 0 && <p>🔴 {drift.missing.length} resource(s) captured but no longer exist.</p>}
          {drift.changed.length > 0 && <p>🟡 {drift.changed.length} resource(s) have changed since capture.</p>}
          {drift.orphaned.length > 0 && <p>⚪ {drift.orphaned.length} resource(s) linked to the project but not captured.</p>}
        </div>
      )}
      <pre style={{ margin: '0 12px 12px', padding: 12, background: 'var(--surface-2, #111)', borderRadius: 6, overflow: 'auto', fontSize: 12, maxHeight: '60vh' }}>
        {json}
      </pre>
    </div>
  );
}

// ── Inline resource detail pane ───────────────────────────────────────────

function ResourceDetailPane({ resource, onClose }: { resource: Resource; onClose: () => void }) {
  const r = resource;
  const k = r.kind;

  function detailLink() {
    if (k === 'container') return `/containers/${(r.data as Container).id}`;
    if (k === 'function') return `/functions/${(r.data as LambdaFunction).id}`;
    if (k === 'route') return `/gateway/${(r.data as GatewayRoute).name}`;
    if (k === 'bucket') return `/buckets/${encodeURIComponent((r.data as Bucket).name)}`;
    if (k === 'database') return `/databases/${(r.data as DatabaseConnectionDetail).id}`;
    return '#';
  }

  return (
    <div className="panel">
      <div className="panel__head">
        <h3>
          <AppIcon name={KIND_ICON[k]} /> {getResourceDisplayName(r)}
        </h3>
        <button className="btn btn--ghost btn--sm" onClick={onClose}>×</button>
      </div>

      <div className="project-detail__resource-meta">
        {k === 'container' && (
          <ContainerMeta c={r.data as Container} />
        )}
        {k === 'function' && (
          <FunctionMeta f={r.data as LambdaFunction} />
        )}
        {k === 'route' && (
          <RouteMeta rt={r.data as GatewayRoute} />
        )}
        {k === 'bucket' && (
          <BucketMeta b={r.data as Bucket} />
        )}
        {k === 'database' && (
          <DatabaseMeta db={r.data as DatabaseConnectionDetail} />
        )}
      </div>

      <div style={{ padding: '0 12px 12px', display: 'flex', gap: 8 }}>
        <Link to={detailLink()} className="btn btn--ghost btn--sm">
          <AppIcon name="external" /> View full detail
        </Link>
        <button className="btn btn--ghost btn--sm" onClick={() => emitOpenAssistant(buildAssistantPrompt(r))}>
          <AppIcon name="assistant" /> Ask Dockyard
        </button>
      </div>
    </div>
  );
}

function getResourceDisplayName(r: Resource): string {
  if (r.kind === 'route') return (r.data as GatewayRoute).displayName || (r.data as GatewayRoute).name;
  return (r.data as any).name;
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="project-detail__meta-row">
      <span className="muted">{label}</span>
      <span>{children}</span>
    </div>
  );
}

function ContainerMeta({ c }: { c: Container }) {
  return (
    <>
      <MetaRow label="Image">{c.image}</MetaRow>
      <MetaRow label="Status">
        <span className={`badge badge--${c.state === 'running' ? 'ok' : 'warn'}`}>{c.state}</span>
      </MetaRow>
      <MetaRow label="Ports">{(c.ports || []).map((p) => `${p.publicPort || p.privatePort}→${p.privatePort}`).join(', ') || '—'}</MetaRow>
      {c.description && <MetaRow label="Description">{c.description}</MetaRow>}
    </>
  );
}

function FunctionMeta({ f }: { f: LambdaFunction }) {
  return (
    <>
      <MetaRow label="Runtime">{f.runtime}</MetaRow>
      <MetaRow label="Updated">{timeAgo(new Date(f.updatedAt).getTime() / 1000)}</MetaRow>
    </>
  );
}

function RouteMeta({ rt }: { rt: GatewayRoute }) {
  return (
    <>
      <MetaRow label="Target">{rt.targetType} → {rt.targetId}</MetaRow>
      {rt.method && <MetaRow label="Method">{rt.method}</MetaRow>}
      {rt.pathPattern && <MetaRow label="Path">{rt.pathPattern}</MetaRow>}
      {rt.domain && <MetaRow label="Domain">{rt.domain} {rt.domainVerified ? '✅' : '⏳'}</MetaRow>}
      <MetaRow label="URL">
        <a href={`/gw/${rt.name}/`} target="_blank" rel="noreferrer">
          /gw/{rt.name}/ <AppIcon name="external" />
        </a>
      </MetaRow>
    </>
  );
}

function BucketMeta({ b }: { b: Bucket }) {
  return (
    <>
      <MetaRow label="Objects">{b.objectCount ?? '—'}</MetaRow>
      <MetaRow label="Size">{b.size != null ? formatBytes(b.size) : '—'}</MetaRow>
      <MetaRow label="Protected">{b.protected ? 'Yes' : 'No'}</MetaRow>
    </>
  );
}

function DatabaseMeta({ db }: { db: DatabaseConnectionDetail }) {
  return (
    <>
      <MetaRow label="Engine">{db.engine}</MetaRow>
      <MetaRow label="Status">
        {db.lastTestStatus === 'ok'
          ? <span className="badge badge--ok">Connected</span>
          : db.lastTestStatus
            ? <span className="badge badge--warn">{db.lastTestStatus}</span>
            : <span className="muted">Not tested</span>}
      </MetaRow>
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function buildAssistantPrompt(r: Resource): string {
  if (r.kind === 'container') {
    const c = r.data as Container;
    return `Explain this Docker container in my project:\n- Name: ${c.name}\n- Image: ${c.image}\n- State: ${c.state}\n${c.description ? `- Description: ${c.description}\n` : ''}What is this container for, and how should I manage it?`;
  }
  if (r.kind === 'function') {
    const f = r.data as LambdaFunction;
    return `Explain this Lambda function in my project:\n- Name: ${f.name}\n- Runtime: ${f.runtime}\n- Last updated: ${new Date(f.updatedAt).toLocaleString()}\nWhat does this function likely do, and how should I use it?`;
  }
  if (r.kind === 'route') {
    const rt = r.data as GatewayRoute;
    return `Explain this gateway route in my project:\n- Name: ${rt.name}\n- Target: ${rt.targetType} → ${rt.targetId}${rt.targetPort ? `:${rt.targetPort}` : ''}\n${rt.method ? `- Method: ${rt.method}\n` : ''}${rt.pathPattern ? `- Path: ${rt.pathPattern}\n` : ''}${rt.domain ? `- Domain: ${rt.domain}\n` : ''}What does this route expose, and how is traffic routed?`;
  }
  if (r.kind === 'bucket') {
    const b = r.data as Bucket;
    return `Explain this storage bucket in my project:\n- Name: ${b.name}\n- Objects: ${b.objectCount ?? 'unknown'}\n- Size: ${b.size != null ? formatBytes(b.size) : 'unknown'}\n- Protected: ${b.protected ? 'Yes' : 'No'}\nWhat is this bucket likely used for, and how should I manage its contents?`;
  }
  if (r.kind === 'database') {
    const db = r.data as DatabaseConnectionDetail;
    return `Explain this database connection in my project:\n- Name: ${db.name}\n- Engine: ${db.engine}\n- Status: ${db.lastTestStatus || 'untested'}\nWhat is this database for, and how should I interact with it?`;
  }
  throw new Error(`Unknown resource kind: ${(r as any).kind}`);
}
