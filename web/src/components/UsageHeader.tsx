import type { UsageSnapshot } from '../types';
import { bytes } from '../format';

interface Props {
  snapshot: UsageSnapshot | null;
  live: boolean;
  onPrune: () => void;
  pruning: boolean;
}

function level(pct: number): 'ok' | 'warn' | 'crit' {
  if (pct >= 90) return 'crit';
  if (pct >= 75) return 'warn';
  return 'ok';
}

export function UsageHeader({ snapshot, live, onPrune, pruning }: Props) {
  const host = snapshot?.host ?? null;
  const docker = snapshot?.docker ?? null;
  const pct = host ? host.usedPercent : 0;
  const gauge = level(pct);

  return (
    <section className="usage" aria-label="Disk usage">
      <div className={`gauge gauge--${gauge}`}>
        <div className="gauge__ring" style={{ ['--pct' as string]: `${pct}` }}>
          <div className="gauge__center">
            <span className="gauge__pct">{host ? `${pct.toFixed(0)}%` : '—'}</span>
            <span className="gauge__label">disk used</span>
          </div>
        </div>
        <div className="gauge__meta">
          <h2>Host disk</h2>
          {host ? (
            <>
              <p className="gauge__figures">
                <strong>{bytes(host.usedBytes)}</strong> used ·{' '}
                <strong>{bytes(host.freeBytes)}</strong> free
              </p>
              <p className="gauge__sub">
                {bytes(host.totalBytes)} total on <code>{host.path}</code>
              </p>
            </>
          ) : (
            <p className="gauge__sub">Host disk stats unavailable.</p>
          )}
          <span className={`live ${live ? 'live--on' : ''}`}>
            <span className="live__dot" />
            {live ? 'live' : 'reconnecting…'}
            {snapshot && (
              <span className="live__ts">
                {new Date(snapshot.timestamp).toLocaleTimeString()}
              </span>
            )}
          </span>
        </div>
      </div>

      <div className="usage__docker">
        <div className="usage__docker-head">
          <h3>Docker footprint</h3>
          <button className="btn btn--ghost" onClick={onPrune} disabled={pruning}>
            {pruning ? 'Pruning…' : 'Reclaim space'}
          </button>
        </div>
        <div className="breakdown">
          {[
            ['Images', docker?.images],
            ['Containers', docker?.containers],
            ['Volumes', docker?.volumes],
            ['Build cache', docker?.buildCache],
          ].map(([label, cat]) => (
            <div className="breakdown__item" key={label as string}>
              <span className="breakdown__label">{label as string}</span>
              <span className="breakdown__val">{bytes((cat as any)?.size)}</span>
              <span className="breakdown__count">{(cat as any)?.count ?? 0} items</span>
            </div>
          ))}
        </div>
        <div className="usage__totals">
          <span>
            Total <strong>{bytes(docker?.totalSize)}</strong>
          </span>
          <span className="usage__reclaim">
            Reclaimable <strong>{bytes(docker?.totalReclaimable)}</strong>
          </span>
        </div>
      </div>

      {snapshot?.error && <p className="usage__error">⚠ {snapshot.error}</p>}
    </section>
  );
}
