import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Bucket, BucketListing } from '../types';
import { api } from '../api';
import { bytes } from '../format';

export function BucketList() {
  const navigate = useNavigate();
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

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

  async function createBucket() {
    const name = newName.trim();
    if (!name) return;
    try {
      await api.bucketCreate(name);
      setNewName('');
      setCreating(false);
      navigate(`/buckets/${name}`);
    } catch (err) {
      setError((err as Error).message);
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
                  <td className="mono">🪣 {b.name}</td>
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
  const navigate = useNavigate();
  const [prefix, setPrefix] = useState('');
  const [listing, setListing] = useState<BucketListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

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

  function openPrefix(next: string) {
    setPrefix(next);
    loadObjects(next);
  }

  async function deleteBucket() {
    if (!confirm(`Delete bucket "${name}"?`)) return;
    try {
      await api.bucketDelete(name);
      navigate('/buckets');
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function uploadFiles(files: FileList | null) {
    if (!files) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        await api.bucketUpload(name, `${prefix}${file.name}`, file);
      }
      await loadObjects(prefix);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function deleteObject(key: string) {
    if (!confirm(`Delete "${key}"?`)) return;
    try {
      await api.bucketDeleteObject(name, key);
      await loadObjects(prefix);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  const crumbs = prefix.split('/').filter(Boolean);

  return (
    <section className="panel">
      <div className="panel__head">
        <div className="mono" style={{ fontSize: '13px' }}>
          <button className="btn btn--ghost btn--sm" onClick={() => openPrefix('')}>
            🪣 {name}
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
                        📁 {folder}/
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
