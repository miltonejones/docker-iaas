import { useState } from 'react';
import type { Preset } from '../types';
import { api, type LaunchRequest } from '../api';

interface Props {
  preset: Preset;
  onClose: () => void;
  onLaunched: () => void;
}

export function LaunchModal({ preset, onClose, onLaunched }: Props) {
  const [name, setName] = useState(`${preset.id}-${Math.random().toString(36).slice(2, 6)}`);
  const [ports, setPorts] = useState(preset.ports.map((p) => ({ ...p })));
  const [env, setEnv] = useState(preset.env.map((e) => ({ ...e })));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const missingRequired = env.some((e) => e.required && !e.value.trim());

  async function submit() {
    setSubmitting(true);
    setError(null);
    const body: LaunchRequest = {
      presetId: preset.id,
      name: name.trim() || undefined,
      ports: ports.map((p) => ({ container: p.container, host: p.host })),
      env: env.map((e) => ({ key: e.key, value: e.value })),
      autoStart: true,
    };
    try {
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

        {ports.length > 0 && (
          <fieldset className="field">
            <legend>Port mappings (host → container)</legend>
            {ports.map((p, i) => (
              <div className="port-row" key={p.container}>
                <input
                  type="number"
                  value={p.host}
                  onChange={(e) => {
                    const next = [...ports];
                    next[i] = { ...p, host: Number(e.target.value) };
                    setPorts(next);
                  }}
                />
                <span className="arrow">→</span>
                <code>{p.container}</code>
                {p.label && <span className="muted">{p.label}</span>}
              </div>
            ))}
          </fieldset>
        )}

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
