import { useCallback, useEffect, useState } from 'react';
import type { BuildCacheEntry, Container, DockerImage, DockerVolume } from '../types';
import { api } from '../api';
import { bytes, timeAgo } from '../format';
import { AppIcon } from '../icons';
import { InfoButton } from './InfoButton';

function ageLabel(epochOrIso: number | string): string {
  if (!epochOrIso) return '—';
  const epoch = typeof epochOrIso === 'number' ? epochOrIso : Date.parse(epochOrIso) / 1000;
  if (isNaN(epoch)) return '—';
  return timeAgo(epoch);
}

type Category = 'Images' | 'Containers' | 'Volumes' | 'Build cache';

interface Props {
  category: Category;
  onClose: () => void;
}

export function FootprintDetail({ category, onClose }: Props) {
  const [images, setImages] = useState<DockerImage[] | null>(null);
  const [containers, setContainers] = useState<Container[] | null>(null);
  const [volumes, setVolumes] = useState<DockerVolume[] | null>(null);
  const [buildCache, setBuildCache] = useState<BuildCacheEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pruning, setPruning] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async (cancelled: { v: boolean }) => {
    try {
      setError(null);
      if (category === 'Images') {
        const data = await api.images();
        if (!cancelled.v) setImages(data);
      } else if (category === 'Containers') {
        const data = await api.containers();
        if (!cancelled.v) setContainers(data);
      } else if (category === 'Volumes') {
        const data = await api.volumes();
        if (!cancelled.v) setVolumes(data);
      } else if (category === 'Build cache') {
        const data = await api.buildCache();
        if (!cancelled.v) setBuildCache(data);
      }
    } catch (err) {
      if (!cancelled.v) setError((err as Error).message);
    }
  }, [category]);

  useEffect(() => {
    const cancelled = { v: false };
    load(cancelled);
    return () => { cancelled.v = true; };
  }, [load]);

  async function onRemoveImage(id: string) {
    if (!confirm('Remove this image?')) return;
    setDeleting(id);
    try {
      await api.removeImage(id);
      setImages((prev) => prev?.filter((img) => img.id !== id) ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(null);
    }
  }

  async function onPruneCache() {
    setPruning(true);
    try {
      const result = await api.pruneBuildCache();
      setBuildCache([]);
      setError(null);
      // Show result briefly
      alert(`Cleared ${result.cachesDeleted} cache entries, reclaimed ${bytes(result.reclaimedBytes)}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPruning(false);
    }
  }

  const data = images || containers || volumes || buildCache;
  const loading = data === null && !error;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--detail" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h3>
            {category}
            <InfoButton
              prompt={`Explain the "${category}" Docker footprint category — what these ${category.toLowerCase()} are, why they take up disk space${data ? ` (currently ${data.length} item${data.length === 1 ? '' : 's'})` : ''}, and when it's safe to remove them.`}
            />
          </h3>
          <div style={{ display: 'flex', gap: 8 }}>
            {category === 'Build cache' && data && data.length > 0 && (
              <button
                className="btn btn--danger"
                onClick={onPruneCache}
                disabled={pruning}
              >
                {pruning ? 'Clearing…' : 'Clear cache'}
              </button>
            )}
            <button className="btn btn--ghost" onClick={onClose}>Close</button>
          </div>
        </div>

        {error && <p className="usage__error"><AppIcon name="warning" /> {error}</p>}

        {loading && <p className="empty">Loading…</p>}

        {data && data.length === 0 && !pruning && (
          <p className="empty">{category === 'Build cache' ? 'Cache cleared.' : 'No items.'}</p>
        )}

        {data && data.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                {category === 'Images' && (
                  <tr>
                    <th>Repository / Tag</th>
                    <th>ID</th>
                    <th className="num">Size</th>
                    <th>Age</th>
                    <th className="actions-col">Actions</th>
                  </tr>
                )}
                {category === 'Containers' && (
                  <tr>
                    <th>Name</th>
                    <th>Image</th>
                    <th>State</th>
                    <th className="num">Size (rw)</th>
                  </tr>
                )}
                {category === 'Volumes' && (
                  <tr>
                    <th>Name</th>
                    <th>Driver</th>
                    <th>Mountpoint</th>
                    <th className="num">Size</th>
                    <th>Age</th>
                  </tr>
                )}
                {category === 'Build cache' && (
                  <tr>
                    <th>ID</th>
                    <th>Type</th>
                    <th>Description</th>
                    <th className="num">Size</th>
                    <th>In use</th>
                    <th>Shared</th>
                  </tr>
                )}
              </thead>
              <tbody>
                {category === 'Images' && (images as DockerImage[]).map((img) => (
                  <tr key={img.id}>
                    <td><code>{img.tags?.join(', ') || '<none>'}</code></td>
                    <td><code>{img.id.slice(0, 12)}</code></td>
                    <td className="num">{bytes(img.size)}</td>
                    <td className="muted">{ageLabel(img.created)}</td>
                    <td className="actions-col">
                      <button
                        className="btn btn--sm btn--danger"
                        disabled={deleting === img.id}
                        onClick={() => onRemoveImage(img.id)}
                      >
                        {deleting === img.id ? '…' : 'Remove'}
                      </button>
                    </td>
                  </tr>
                ))}
                {category === 'Containers' && (containers as Container[]).map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span className={`dot ${c.state === 'running' ? 'dot--up' : 'dot--down'}`} />
                      {c.name}
                    </td>
                    <td><code>{c.image}</code></td>
                    <td>
                      <span className={`state ${c.state === 'running' ? 'state--up' : 'state--down'}`}>
                        {c.state}
                      </span>
                    </td>
                    <td className="num">{bytes(c.sizeRw)}</td>
                  </tr>
                ))}
                {category === 'Volumes' && (volumes as DockerVolume[]).map((v) => (
                  <tr key={v.name}>
                    <td><code>{v.name}</code></td>
                    <td>{v.driver}</td>
                    <td className="muted" style={{ fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.mountpoint}</td>
                    <td className="num">{bytes(v.size)}</td>
                    <td className="muted">{ageLabel(v.createdAt)}</td>
                  </tr>
                ))}
                {category === 'Build cache' && (buildCache as BuildCacheEntry[]).map((e) => (
                  <tr key={e.id}>
                    <td><code>{e.id || '—'}</code></td>
                    <td>{e.type}</td>
                    <td className="muted" style={{ fontSize: 12, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.description || '—'}</td>
                    <td className="num">{bytes(e.size)}</td>
                    <td>{e.inUse ? '✓' : ''}</td>
                    <td>{e.shared ? '✓' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
