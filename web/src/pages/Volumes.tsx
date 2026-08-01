import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DockerVolume } from '../types';
import { api } from '../api';
import { bytes, timeAgo } from '../format';
import { onRefresh } from '../refresh';
import { AppIcon } from '../icons';
import { useToast } from '../ToastContext';
import { useConfirm } from '../components/ConfirmContext';

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function VolumesPage() {
  const navigate = useNavigate();
  const [volumes, setVolumes] = useState<DockerVolume[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [nameError, setNameError] = useState('');
  const [pruning, setPruning] = useState(false);
  const toast = useToast();
  const { askConfirm } = useConfirm();

  const loadVolumes = useCallback(async () => {
    try {
      setVolumes(await api.volumes());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { loadVolumes(); }, [loadVolumes]);
  useEffect(() => onRefresh(loadVolumes), [loadVolumes]);

  function validateName(name: string) {
    if (!name.trim()) { setNameError('Name is required.'); return false; }
    if (!NAME_RE.test(name)) { setNameError('Name must match /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.'); return false; }
    setNameError('');
    return true;
  }

  async function createVolume() {
    const name = newName.trim();
    if (!validateName(name)) return;
    try {
      await api.volumeCreate(name);
      setNewName('');
      setCreating(false);
      setNameError('');
      await loadVolumes();
      toast.success(`Created volume "${name}".`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function removeVolume(vol: DockerVolume) {
    if (vol.system) {
      toast.error('System volumes cannot be removed.');
      return;
    }
    if (!await askConfirm(`Delete volume "${vol.name}"?`)) return;

    async function doRemove(force: boolean) {
      try {
        await api.volumeRemove(vol.name, force);
        await loadVolumes();
        toast.success(`Deleted volume "${vol.name}".`);
      } catch (err) {
        const msg = (err as Error).message;
        toast.error(msg);
        // If in-use (409) and not already forcing, offer force retry
        if (!force && msg.includes('in use')) {
          if (await askConfirm(`${msg}\n\nForce removal anyway? This may cause data loss for the containers using it.`)) {
            await doRemove(true);
          }
        }
      }
    }
    await doRemove(false);
  }

  async function pruneVolumes() {
    if (!await askConfirm('Remove all volumes not used by any container? This cannot be undone.')) return;
    setPruning(true);
    try {
      const result = await api.volumePrune();
      await loadVolumes();
      toast.success(`Pruned ${result.volumesDeleted.length} volume${result.volumesDeleted.length === 1 ? '' : 's'}, reclaimed ${bytes(result.spaceReclaimed)}.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPruning(false);
    }
  }

  const hasNonSystemVolumes = volumes.some((v) => !v.system);

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>
          Volumes <span className="count">{volumes.length}</span>
        </h2>
        <div style={{ display: 'flex', gap: '6px' }}>
          {creating ? (
            <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
              <div>
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => { setNewName(e.target.value); if (nameError) validateName(e.target.value); }}
                  onKeyDown={(e) => e.key === 'Enter' && createVolume()}
                  placeholder="volume-name"
                  spellCheck={false}
                  className={nameError ? 'input--error' : ''}
                />
                {nameError && <p className="muted empty-sm" style={{ color: 'var(--red)', marginTop: 2 }}>{nameError}</p>}
              </div>
              <button className="btn btn--sm" onClick={createVolume}>Add</button>
              <button className="btn btn--sm btn--ghost" onClick={() => { setCreating(false); setNameError(''); }}>Cancel</button>
            </div>
          ) : (
            <button className="btn btn--primary btn--sm" onClick={() => setCreating(true)} title="New volume">
              <AppIcon name="plus" />
            </button>
          )}
          {hasNonSystemVolumes && (
            <button className="btn btn--sm btn--danger" onClick={pruneVolumes} disabled={pruning}>
              {pruning ? 'Pruning…' : 'Prune unused'}
            </button>
          )}
        </div>
      </div>

      {error && <p className="muted empty-sm">{error}</p>}

      {volumes.length === 0 ? (
        <p className="empty">No volumes yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Driver</th>
                <th className="num">Size</th>
                <th>Used by</th>
                <th>Created</th>
                <th className="actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {volumes.map((v) => (
                <tr key={v.name}>
                  <td>
                    <AppIcon name="harddrive" /> {v.name}
                    {v.system && <span className="badge" style={{ marginLeft: 6, background: 'var(--yellow)', color: '#000', fontSize: '11px' }}>system</span>}
                  </td>
                  <td className="muted">{v.driver}</td>
                  <td className="num mono">{v.size != null ? bytes(v.size) : '—'}</td>
                  <td>
                    {v.usedBy.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      v.usedBy.map((u) => (
                        <button
                          key={u.containerId}
                          className="instance-link"
                          style={{ marginRight: 4, marginBottom: 2 }}
                          onClick={() => navigate(`/containers/${u.containerId}`)}
                          title={`${u.destination} ${u.rw ? '(rw)' : '(ro)'}`}
                        >
                          {u.containerName}
                        </button>
                      ))
                    )}
                  </td>
                  <td className="muted">{v.createdAt ? timeAgo(new Date(v.createdAt).getTime() / 1000) : '—'}</td>
                  <td className="actions-col">
                    {!v.system && (
                      <button className="btn btn--sm btn--danger" onClick={() => removeVolume(v)}>
                        Remove
                      </button>
                    )}
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
