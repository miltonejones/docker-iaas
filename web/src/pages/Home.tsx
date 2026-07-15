import { useEffect, useState } from 'react';
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
  const [fnCount, setFnCount] = useState(0);

  useEffect(() => {
    api.lambdaListFunctions().then((list) => setFnCount(list.length)).catch(() => {});
  }, []);

  return (
    <div>
      <UsageHeader snapshot={snapshot} live={live} onPrune={onPrune} pruning={pruning} />

      <div className="home-cards">
        <div className="home-card">
          <span className="home-card__num">{runningCount}</span>
          <span className="home-card__label">Running containers</span>
        </div>
        <div className="home-card">
          <span className="home-card__num">{totalCount}</span>
          <span className="home-card__label">Total containers</span>
        </div>
        <div className="home-card">
          <span className="home-card__num">{fnCount}</span>
          <span className="home-card__label">Saved functions</span>
        </div>
      </div>
    </div>
  );
}
