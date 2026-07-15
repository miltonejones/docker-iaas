import { useEffect, useState } from 'react';
import type { Preset } from '../types';
import { api, type LaunchRequest } from '../api';

interface Props {
  preset: Preset;
  onClose: () => void;
  onLaunched: () => void;
  /** Pre-fill overrides for relaunch (from detail view). */
  prefill?: { name?: string; ports?: { container: string; host: number; label?: string }[]; env?: { key: string; value: string }[] };
  /** If set, this container will be removed before launching the new one. */
  replaceId?: string;
}

export function LaunchModal({ preset, onClose, onLaunched, prefill, replaceId }: Props) {
  const [name, setName] = useState(prefill?.name || `${preset.id}-${Math.random().toString(36).slice(2, 6)}`);
  const [ports, setPorts] = useState(
    (prefill?.ports ?? preset.ports).map((p) => ({ ...p })),
  );
  const [env, setEnv] = useState(
    (prefill?.env ?? preset.env).map((e) => ({ ...e })),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usedPorts, setUsedPorts] = useState<Set<number>>(new Set());

  // Fetch used ports for conflict detection.
  useEffect(() => {
    api.usedPorts().then(({ ports: list }) => setUsedPorts(new Set(list))).catch(() => {});
  }, []);

  const missingRequired = env.some((e) => e.required && !e.value.trim());

  const conflictingPorts = ports
    .filter((p) => p.host > 0 && usedPorts.has(p.host))
    .map((p) => p.host);

  async function submit() {
    setSubmitting(true);
    setError(null);

    if (conflictingPorts.length > 0) {
      setError(`Host port(s) already in use: ${conflictingPorts.join(', ')}. Change them to avoid conflicts.`);
      setSubmitting(false);
      return;
    }

    const body: LaunchRequest = {
      presetId: preset.id,
      name: name.trim() || undefined,
      ports: ports
        .filter((p) => p.container.trim() && p.host > 0)
        .map((p) => ({ container: p.container.trim(), host: p.host })),
      env: env.map((e) => ({ key: e.key, value: e.value })),
      volumes: preset.volumes,
      autoStart: true,
    };
    try {
      // If replacing, remove the old container first.
      if (replaceId) {
        await api.remove(replaceId, true);
      }
      await api.launch(body);
      onLaunched();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h3>
            <span aria-hidden>{preset.icon}</span> Launch {preset.name}
          </h3>
          <button className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <label className="field">
          <span>Instance name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        </label>

        <fieldset className="field">
          <legend>Port mappings (host → container)</legend>
          {ports.length === 0 && (
            <p className="muted empty-sm">No ports mapped. Add one below to make the instance reachable.</p>
          )}
          {ports.map((p, i) => {
            const conflict = p.host > 0 && usedPorts.has(p.host);
            return (
              <div className={`port-row${conflict ? ' port-row--conflict' : ''}`} key={i}>
                <input
                  type="number"
                  value={p.host}
                  placeholder="host"
                  className={conflict ? 'input--conflict' : ''}
                  onChange={(e) => {
                    const next = [...ports];
                    next[i] = { ...p, host: Number(e.target.value) };
                    setPorts(next);
                  }}
                />
                <span className="arrow">→</span>
                <input
                  className={`port-container${conflict ? ' input--conflict' : ''}`}
                  value={p.container}
                  placeholder="80/tcp"
                  onChange={(e) => {
                    const next = [...ports];
                    next[i] = { ...p, container: e.target.value };
                    setPorts(next);
                  }}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    // Auto-suffix bare numbers with /tcp.
                    if (/^\d+$/.test(v)) {
                      const next = [...ports];
                      next[i] = { ...p, container: `${v}/tcp` };
                      setPorts(next);
                    }
                  }}
                />
                {p.label && <span className="muted">{p.label}</span>}
                {conflict && <span className="port-conflict-msg">in use</span>}
                <button
                  type="button"
                  className="btn btn--sm btn--ghost port-remove"
                  title="Remove this mapping"
                  onClick={() => {
                    const next = ports.filter((_, idx) => idx !== i);
                    setPorts(next);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="btn btn--sm"
            style={{ marginTop: '8px' }}
            onClick={() => {
              setPorts([...ports, { container: '', host: 0, label: '' }]);
            }}
          >
            + Add port
          </button>
        </fieldset>

        {env.length > 0 && (
          <fieldset className="field">
            <legend>Environment</legend>
            {env.map((e, i) => (
              <label className="env-row" key={e.key}>
                <code>
                  {e.key}
                  {e.required && <span className="req">*</span>}
                </code>
                <input
                  value={e.value}
                  placeholder={e.description || (e.required ? 'required' : 'optional')}
                  onChange={(ev) => {
                    const next = [...env];
                    next[i] = { ...e, value: ev.target.value };
                    setEnv(next);
                  }}
                />
              </label>
            ))}
          </fieldset>
        )}

        {(preset.volumes ?? []).length > 0 && (
          <fieldset className="field">
            <legend>Persistent volumes</legend>
            <p className="muted" style={{ fontSize: '12px', margin: '0 0 8px' }}>
              Named Docker volumes that survive container removal.
            </p>
            {preset.volumes!.map((v) => (
              <div className="port-row" key={v}>
                <code style={{ flex: 1 }}>{v}</code>
                <span className="muted">→ named volume (auto-created)</span>
              </div>
            ))}
          </fieldset>
        )}

        {error && <p className="usage__error">⚠ {error}</p>}

        <div className="modal__foot">
          <span className="muted mono">{preset.image}</span>
          <button
            className="btn btn--primary"
            disabled={submitting || missingRequired}
            onClick={submit}
          >
            {submitting ? 'Launching…' : missingRequired ? 'Fill required fields' : 'Launch instance'}
          </button>
        </div>
      </div>
    </div>
  );
}
