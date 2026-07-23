import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Bucket, BucketListing } from '../types';
import { api } from '../api';
import { bytes } from '../format';
import { onRefresh } from '../refresh';
import { AppIcon } from '../icons';
import { InfoButton } from './InfoButton';
import { useToast } from '../ToastContext';
import { useConfirm } from "./ConfirmContext";

export function BucketList() {
  const navigate = useNavigate();
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const toast = useToast();

  const loadBuckets = useCallback(async () => {
    try {
      setBuckets(await api.bucketList());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    loadBuckets();
  }, [loadBuckets]);

  // Reload when the assistant mutates buckets (create/delete/write).
  useEffect(() => onRefresh(loadBuckets), [loadBuckets]);

  async function createBucket() {
    const name = newName.trim();
    if (!name) return;
    try {
      await api.bucketCreate(name);
      setNewName('');
      setCreating(false);
      navigate(`/buckets/${name}`);
      toast.success(`Created bucket "${name}".`);
    } catch (err) {
      setError((err as Error).message);
      toast.error((err as Error).message);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>
          Buckets <span className="count">{buckets.length}</span>
        </h2>
        {creating ? (
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createBucket()}
              placeholder="bucket-name"
              spellCheck={false}
            />
            <button className="btn btn--sm" onClick={createBucket}>
              Add
            </button>
            <button className="btn btn--sm btn--ghost" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn btn--primary btn--sm" onClick={() => setCreating(true)}>
            + New bucket
          </button>
        )}
      </div>

      {error && <p className="muted empty-sm">{error}</p>}

      {buckets.length === 0 ? (
        <p className="empty">No buckets yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">Size</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.name} onClick={() => navigate(`/buckets/${b.name}`)}>
                  <td className="mono"><AppIcon name="bucket" /> {b.name}{b.protected && <span className="protected-badge" title="Protected from deletion"> 🔒</span>}</td>
                  <td className="num mono">{bytes(b.size ?? 0)}</td>
                  <td className="muted">{b.creationDate ? new Date(b.creationDate).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function BucketDetail({ name }: { name: string }) {
  const { askConfirm } = useConfirm();
  const navigate = useNavigate();
  const [prefix, setPrefix] = useState('');
  const [listing, setListing] = useState<BucketListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [protect, setProtect] = useState(false);
  const [protecting, setProtecting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const loadObjects = useCallback(async (atPrefix: string) => {
    setLoading(true);
    setError(null);
    try {
      setListing(await api.bucketObjects(name, atPrefix));
    } catch (err) {
      setError((err as Error).message);
      setListing(null);
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    setPrefix('');
    loadObjects('');
  }, [name, loadObjects]);

  // Load bucket metadata (for protected flag) on mount.
  useEffect(() => {
    api.bucketGet(name).then((meta) => setProtect(meta.protected)).catch(() => {});
  }, [name]);

  // Reload the current prefix when the assistant writes/deletes objects here.
  useEffect(() => onRefresh(() => loadObjects(prefix)), [loadObjects, prefix]);

  function openPrefix(next: string) {
    setPrefix(next);
    loadObjects(next);
  }

  async function toggleProtect() {
    setProtecting(true);
    try {
      const res = await api.bucketUpdateProtected(name, !protect);
      setProtect(res.protected);
      toast.success(res.protected ? `Bucket "${name}" is now protected from deletion.` : `Bucket "${name}" is no longer protected.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setProtecting(false);
    }
  }

  async function deleteBucket() {
    if (protect) {
      toast.error('This bucket is protected — unprotect it before deleting.');
      return;
    }
    if (!await askConfirm(`Delete bucket "${name}"?`)) return;
    try {
      await api.bucketDelete(name);
      navigate('/buckets');
      toast.success(`Deleted bucket "${name}".`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function uploadFiles(files: FileList | null) {
    if (!files) return;
    setUploading(true);
    setError(null);
    try {
      const list = Array.from(files);
      for (const file of list) {
        await api.bucketUpload(name, `${prefix}${file.name}`, file);
      }
      await loadObjects(prefix);
      toast.success(`Uploaded ${list.length} file${list.length === 1 ? '' : 's'}.`);
    } catch (err) {
      setError((err as Error).message);
      toast.error((err as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function deleteObject(key: string) {
    if (protect) {
      toast.error('This bucket is protected — unprotect it before deleting objects.');
      return;
    }
    if (!await askConfirm(`Delete "${key}"?`)) return;
    try {
      await api.bucketDeleteObject(name, key);
      await loadObjects(prefix);
      toast.success(`Deleted "${key}".`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const crumbs = prefix.split('/').filter(Boolean);

  return (
    <section className="panel">
      <div className="panel__head">
        <div className="mono" style={{ fontSize: '13px' }}>
          <button className="btn btn--ghost btn--sm" onClick={() => openPrefix('')}>
            <AppIcon name="bucket" /> {name}
          </button>
          {crumbs.map((seg, i) => (
            <span key={i}>
              {' / '}
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => openPrefix(crumbs.slice(0, i + 1).join('/') + '/')}
              >
                {seg}
              </button>
            </span>
          ))}
          <InfoButton
            prompt={`Explain the "${name}" bucket${prefix ? ` (currently browsing "${prefix}")` : ''} — what it's likely used for and what kind of objects it holds.`}
          />
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            ref={fileInput}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => uploadFiles(e.target.files)}
          />
          <button
            className="btn btn--sm"
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
          >
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
          <button
            className={`btn btn--sm${protect ? ' btn--danger' : ''}`}
            disabled={protecting}
            onClick={toggleProtect}
            title={protect ? 'Unprotect (allow deletion)' : 'Protect from accidental deletion'}
          >
            {protecting ? '…' : protect ? '🔒 Unprotect' : '🔓 Protect'}
          </button>
          <button className="btn btn--sm btn--danger" onClick={deleteBucket}>
            Delete bucket
          </button>
        </div>
      </div>

      {error && <p className="muted empty-sm">{error}</p>}

      {loading ? (
        <p className="muted empty-sm">Loading…</p>
      ) : !listing || (listing.prefixes.length === 0 && listing.objects.length === 0) ? (
        <p className="empty">Empty. Upload a file to get started.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">Size</th>
                <th>Modified</th>
                <th className="actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {listing.prefixes.map((p) => {
                const folder = p.slice(prefix.length, -1);
                return (
                  <tr key={p}>
                    <td>
                      <button className="instance-link" onClick={() => openPrefix(p)}>
                        <AppIcon name="folder" /> {folder}/
                      </button>
                    </td>
                    <td className="num mono">—</td>
                    <td className="muted">—</td>
                    <td className="actions-col" />
                  </tr>
                );
              })}
              {listing.objects.map((o) => {
                const objName = o.key.slice(prefix.length);
                return (
                  <tr key={o.key}>
                    <td className="mono">{objName}</td>
                    <td className="num mono">{bytes(o.size)}</td>
                    <td className="muted">
                      {o.lastModified ? new Date(o.lastModified).toLocaleString() : '—'}
                    </td>
                    <td className="actions-col">
                      <a
                        className="btn btn--sm"
                        href={api.bucketObjectUrl(name, o.key)}
                        download={objName}
                      >
                        Download
                      </a>
                      <button className="btn btn--sm btn--danger" onClick={() => deleteObject(o.key)}>
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
    </section>
  );
}
