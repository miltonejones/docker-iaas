import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GatewayRoute, GatewayTrafficTimeseries, UsageSnapshot } from '../types';
import { UsageHeader } from '../components/UsageHeader';
import { api } from '../api';
import { onRefresh } from '../refresh';
import { AppIcon } from '../icons';

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
  const [openIssueCount, setOpenIssueCount] = useState(0);
  const [resolvedIssueCount, setResolvedIssueCount] = useState(0);
  const [gatewayLinks, setGatewayLinks] = useState<GatewayRoute[]>([]);
  const [traffic, setTraffic] = useState<GatewayTrafficTimeseries | null>(null);

  function loadCounts() {
    api.lambdaListFunctions().then((list) => setFnCount(list.length)).catch(() => {});
    api.bucketList().then((list) => setBucketCount(list.length)).catch(() => {});
    api.gatewayTrafficTimeseries().then(setTraffic).catch(() => {});
    api.assistantIssueCounts().then((counts) => {
      setOpenIssueCount(counts.open);
      setResolvedIssueCount(counts.resolved);
    }).catch(() => {});
    api.gatewayList().then((list) => {
      setRouteCount(list.length);
      const links = new Map<string, GatewayRoute>();
      for (const route of list) {
        if ((route.targetType === 'bucket' || route.targetType === 'container') && !links.has(route.name)) {
          links.set(route.name, route);
        }
      }
      setGatewayLinks(Array.from(links.values()).sort((a, b) => a.name.localeCompare(b.name)));
    }).catch(() => {});
  }

  useEffect(() => {
    loadCounts();
  }, []);

  // Container counts come from App props (refreshed on emit); reload the
  // function/bucket/route counts when the assistant mutates any of them.
  useEffect(() => onRefresh(loadCounts), []);

  const hourStart = new Date();
  hourStart.setUTCMinutes(0, 0, 0);
  const hourlyTraffic = Array.from({ length: 24 }, (_, index) => {
    const start = new Date(hourStart);
    start.setUTCHours(start.getUTCHours() - (23 - index));
    const bucket = traffic?.buckets.find((item) => item.start === start.toISOString());
    return {
      start,
      requestCount: bucket?.requestCount ?? 0,
    };
  });
  const maxHourlyRequests = Math.max(1, ...hourlyTraffic.map((bucket) => bucket.requestCount));
  const responseMix = (traffic?.buckets ?? []).reduce(
    (totals, bucket) => ({
      successful: totals.successful + bucket.successfulRequests,
      clientErrors: totals.clientErrors + bucket.clientErrorRequests,
      serverErrors: totals.serverErrors + bucket.serverErrorRequests,
    }),
    { successful: 0, clientErrors: 0, serverErrors: 0 },
  );
  const trafficTotal = responseMix.successful + responseMix.clientErrors + responseMix.serverErrors;

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
        <div className="home-card glow">
          <span className="home-card__num">{openIssueCount}</span>
          <span className="home-card__label">Open issues</span>
        </div>
        <div className="home-card glow">
          <span className="home-card__num">{resolvedIssueCount}</span>
          <span className="home-card__label">Resolved issues</span>
        </div>
      </div>

      <div className="home-links-grid">
        <section className="panel home-traffic">
          <div className="panel__head">
            <h2>Gateway traffic <span className="count">24h</span></h2>
          </div>
          {trafficTotal === 0 ? (
            <p className="empty">No gateway requests recorded in the last 24 hours.</p>
          ) : (
            <>
              <div className="home-traffic__chart" role="img" aria-label="Gateway requests by hour">
                {hourlyTraffic.map((bucket, index) => (
                  <div className="home-traffic__bar-wrap" key={bucket.start.toISOString()}>
                    <div
                      className="home-traffic__bar"
                      style={{ height: `${Math.max(3, (bucket.requestCount / maxHourlyRequests) * 100)}%` }}
                      title={`${bucket.start.toLocaleTimeString([], { hour: 'numeric' })}: ${bucket.requestCount} requests`}
                    />
                    {index % 6 === 0 && (
                      <span className="home-traffic__hour">
                        {bucket.start.toLocaleTimeString([], { hour: 'numeric' })}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <div className="home-traffic__mix" aria-label="Gateway response mix">
                {[
                  ['2xx / 3xx', responseMix.successful, 'home-traffic__mix--ok'],
                  ['4xx', responseMix.clientErrors, 'home-traffic__mix--warn'],
                  ['5xx', responseMix.serverErrors, 'home-traffic__mix--error'],
                ].map(([label, count, className]) => (
                  <span className="home-traffic__mix-item" key={label as string}>
                    <i className={className as string} />
                    {label as string} <strong>{count as number}</strong>
                  </span>
                ))}
              </div>
            </>
          )}
        </section>

        <section className="panel">
          <div className="panel__head">
            <h2>Gateway links <span className="count">{gatewayLinks.length}</span></h2>
            {gatewayLinks.length > 6 && (
              <button className="btn btn--ghost btn--sm" onClick={() => navigate('/gateway')}>
                View all →
              </button>
            )}
          </div>
          {gatewayLinks.length === 0 ? (
            <p className="empty">No bucket or web-app gateway links yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {gatewayLinks.slice(0, 6).map((route) => (
                    <tr key={route.name}>
                      <td>
                        <AppIcon name={route.targetType === 'bucket' ? 'bucket' : 'container'} />{' '}
                        <strong>{route.displayName || route.name}</strong>
                      </td>
                      <td className="mono muted">
                        <a href={`/gw/${route.name}/`} target="_blank" rel="noreferrer">
                          /gw/{route.name}/ <AppIcon name="external" />
                        </a>
                      </td>
                      <td className="muted">
                        {route.targetType === 'bucket' ? 'Bucket site' : 'Web app'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
