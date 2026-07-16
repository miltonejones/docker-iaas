import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { UsageSnapshot } from '../types';
import { UsageHeader } from '../components/UsageHeader';
import { api } from '../api';

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

  useEffect(() => {
    api.lambdaListFunctions().then((list) => setFnCount(list.length)).catch(() => {});
    api.bucketList().then((list) => setBucketCount(list.length)).catch(() => {});
    api.gatewayList().then((list) => setRouteCount(list.length)).catch(() => {});
  }, []);

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
    </div>
  );
}
