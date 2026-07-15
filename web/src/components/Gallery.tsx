import { useMemo, useState } from 'react';
import type { Preset } from '../types';

interface Props {
  presets: Preset[];
  onLaunch: (preset: Preset) => void;
}

export function Gallery({ presets, onLaunch }: Props) {
  const [filter, setFilter] = useState<string>('All');
  const categories = useMemo(
    () => ['All', ...Array.from(new Set(presets.map((p) => p.category)))],
    [presets],
  );
  const shown = filter === 'All' ? presets : presets.filter((p) => p.category === filter);

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Launch gallery</h2>
        <div className="chips">
          {categories.map((c) => (
            <button
              key={c}
              className={`chip ${filter === c ? 'chip--on' : ''}`}
              onClick={() => setFilter(c)}
            >
              {c}
            </button>
          ))}
        </div>
      </div>
      <div className="gallery">
        {shown.map((p) => (
          <article className="card" key={p.id}>
            <div className="card__icon" aria-hidden>
              {p.icon}
            </div>
            <div className="card__body">
              <h3>{p.name}</h3>
              <p className="card__desc">{p.description}</p>
              <div className="card__meta">
                <code>{p.image}</code>
                {p.approxSize && <span className="card__size">{p.approxSize}</span>}
              </div>
            </div>
            <button className="btn btn--primary card__launch" onClick={() => onLaunch(p)}>
              Launch
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
