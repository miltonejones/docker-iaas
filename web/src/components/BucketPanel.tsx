import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bucket, BucketListing } from '../types';
import { api } from '../api';
import { bytes } from '../format';

export function BucketPanel() {
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [activeBucket, setActiveBucket] = useState<string | null>(null);
  const [prefix, setPrefix] = useState('');
  const [listing, setListing] = useState<BucketListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

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

  const loadObjects = useCallback(async (bucket: string, atPrefix: string) => {
    setLoading(true);
    setError(null);
    try {
      setListing(await api.bucketObjects(bucket, atPrefix));
    } catch (err) {
      setError((err as Error).message);
      setListing(null);
    } finally {
      setLoading(false);
    }
  }, []);

  function selectBucket(name: string) {
    setActiveBucket(name);
    setPrefix('');
    loadObjects(name, '');
  }

  function openPrefix(next: string) {
    if (!activeBucket) return;
    setPrefix(next);
    loadObjects(activeBucket, next);
  }

  async function createBucket() {
    const name = newName.trim();
    if (!name) return;
    try {
      await api.bucketCreate(name);
      setNewName('');
      setCreating(false);
      await loadBuckets();
      selectBucket(name);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function deleteBucket(name: string) {
    if (!confirm(`Delete bucket "${name}"?`)) return;
    try {
      await api.bucketDelete(name);
      setBuckets((prev) => prev.filter((b) => b.name !== name));
      if (activeBucket === name) {
        setActiveBucket(null);
        setListing(null);
      }
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function uploadFiles(files: FileList | null) {
    if (!files || !activeBucket) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        await api.bucketUpload(activeBucket, `${prefix}${file.name}`, file);
      }
      await loadObjects(activeBucket, prefix);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function deleteObject(key: string) {
    if (!activeBucket || !confirm(`Delete "${key}"?`)) return;
    try {
      await api.bucketDeleteObject(activeBucket, key);
      await loadObjects(activeBucket, prefix);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  const crumbs = prefix.split('/').filter(Boolean);

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>
          Buckets <span className="count">{buckets.length}</span>
        </h2>
      </div>

      <div className="panel-layout">
        {/* Sidebar — bucket list */}
        <aside className="panel-sidebar">
          {creating ? (
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                className="panel-new-btn"
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
            </div>
          ) : (
            <button className="btn btn--primary panel-new-btn" onClick={() => setCreating(true)}>
              + New bucket
            </button>
          )}
          <div className="panel-item-list">
            {buckets.length === 0 ? (
              <p className="muted empty-sm">No buckets yet.</p>
            ) : (
              buckets.map((b) => (
                <button
                  key={b.name}
                  className={`panel-item${b.name === activeBucket ? ' panel-item--active' : ''}`}
                  onClick={() => selectBucket(b.name)}
                >
                  <span className="panel-item-name">🪣 {b.name}</span>
                </button>
              ))
            )}
          </div>
        </aside>

        {/* Main — object browser */}
        <div className="panel-main">
          {!activeBucket ? (
            <p className="empty">Select or create a bucket to browse its objects.</p>
          ) : (
            <>
              <div className="panel__head" style={{ marginBottom: 0 }}>
                <div className="mono" style={{ fontSize: '13px' }}>
                  <button className="btn btn--ghost btn--sm" onClick={() => openPrefix('')}>
                    {activeBucket}
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
                  <button className="btn btn--sm btn--danger" onClick={() => deleteBucket(activeBucket)}>
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
                        const name = o.key.slice(prefix.length);
                        return (
                          <tr key={o.key}>
                            <td className="mono">{name}</td>
                            <td className="num mono">{bytes(o.size)}</td>
                            <td className="muted">
                              {o.lastModified ? new Date(o.lastModified).toLocaleString() : '—'}
                            </td>
                            <td className="actions-col">
                              <a
                                className="btn btn--sm"
                                href={api.bucketObjectUrl(activeBucket, o.key)}
                                download={name}
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
            </>
          )}
        </div>
      </div>
    </section>
  );
}
