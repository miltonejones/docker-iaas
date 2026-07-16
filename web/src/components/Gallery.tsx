import { useMemo, useState } from 'react';
import type { Preset } from '../types';
import { diskImpact } from '../format';

interface Props {
  presets: Preset[];
  onLaunch: (preset: Preset) => void;
  freeBytes?: number | null;
}

export function Gallery({ presets, onLaunch, freeBytes = null }: Props) {
  const [filter, setFilter] = useState<string>('OS');
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
        {shown.map((p) => {
          const impact = diskImpact(p.diskImpact, freeBytes);
          return (
            <article className="card glow" key={p.id}>
              <div className="card__icon" aria-hidden>
                {p.icon}
              </div>
              <div className="card__body">
                <h3>{p.name}</h3>
                <p className="card__desc">{p.description}</p>
                <div className="card__meta">
                  <code>{p.image}</code>
                </div>
                {impact && (
                  <div className={`impact impact--${impact.level}`} title="Approximate on-disk footprint">
                    <span className="impact__size">{impact.onDiskLabel}</span>
                    <span className="impact__pct">
                      {impact.percentOfFree != null
                        ? impact.fits
                          ? `${impact.percentOfFree < 0.1 ? '<0.1' : impact.percentOfFree.toFixed(1)}% of free`
                          : "won't fit"
                        : 'on disk'}
                    </span>
                  </div>
                )}
              </div>
              <button
                className="btn btn--primary card__launch"
                disabled={impact ? !impact.fits : false}
                onClick={() => onLaunch(p)}
              >
                Launch
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
