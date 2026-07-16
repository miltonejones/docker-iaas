import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { UsageSnapshot } from '../types';
import { UsageHeader } from '../components/UsageHeader';
import { api } from '../api';
import { onRefresh } from '../refresh';

interface Props {
  snapshot: UsageSnapshot | null;
  live: boolean;
  onPrune: () => void;
  pruning: boolean;
  runningCount: number;
  totalCount: number;
}

export function HomePage({ snapshot, live, onPrune, pruning, runningCount, totalCount }: Props) {
  const navigate = useNavigate();
  const [fnCount, setFnCount] = useState(0);
  const [bucketCount, setBucketCount] = useState(0);
  const [routeCount, setRouteCount] = useState(0);

  function loadCounts() {
    api.lambdaListFunctions().then((list) => setFnCount(list.length)).catch(() => {});
    api.bucketList().then((list) => setBucketCount(list.length)).catch(() => {});
    api.gatewayList().then((list) => setRouteCount(list.length)).catch(() => {});
  }

  useEffect(() => {
    loadCounts();
  }, []);

  // Container counts come from App props (refreshed on emit); reload the
  // function/bucket/route counts when the assistant mutates any of them.
  useEffect(() => onRefresh(loadCounts), []);

  return (
    <div>
      <UsageHeader snapshot={snapshot} live={live} onPrune={onPrune} pruning={pruning} />

      <div className="home-cards">
        <button className="home-card glow" onClick={() => navigate('/containers')}>
          <span className="home-card__num">{runningCount}</span>
          <span className="home-card__label">Running containers</span>
        </button>
        <button className="home-card glow" onClick={() => navigate('/containers')}>
          <span className="home-card__num">{totalCount}</span>
          <span className="home-card__label">Total containers</span>
        </button>
        <button className="home-card glow" onClick={() => navigate('/functions')}>
          <span className="home-card__num">{fnCount}</span>
          <span className="home-card__label">Saved functions</span>
        </button>
        <button className="home-card glow" onClick={() => navigate('/buckets')}>
          <span className="home-card__num">{bucketCount}</span>
          <span className="home-card__label">Buckets</span>
        </button>
        <button className="home-card glow" onClick={() => navigate('/gateway')}>
          <span className="home-card__num">{routeCount}</span>
          <span className="home-card__label">Gateway routes</span>
        </button>
      </div>

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel__head">
          <h2>Quick links</h2>
        </div>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              <tr>
                <td className="mono"><a href="http://dockyard.test:4300/" target="_blank" rel="noreferrer">dockyard.test:4300</a></td>
                <td className="muted">Dockyard.ai console (production)</td>
              </tr>
              <tr>
                <td className="mono"><a href="http://dockyard.test:5173/" target="_blank" rel="noreferrer">dockyard.test:5173</a></td>
                <td className="muted">Dockyard.ai console (dev / Vite)</td>
              </tr>
              <tr>
                <td className="mono"><a href="http://minio.test:9000/" target="_blank" rel="noreferrer">minio.test:9000</a></td>
                <td className="muted">MinIO S3 API</td>
              </tr>
              <tr>
                <td className="mono"><a href="http://minio-console.test:9001/" target="_blank" rel="noreferrer">minio-console.test:9001</a></td>
                <td className="muted">MinIO web console</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
