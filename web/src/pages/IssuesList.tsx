import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { AssistantIssue } from '../types';

const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'closed', label: 'Closed' },
];

const CATEGORY_LABELS: Record<string, string> = {
  bug: 'Bug',
  missing_feature: 'Missing Feature',
  performance: 'Performance',
  security: 'Security',
  general: 'General',
};

function timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function IssuesPage({ onCreateIssue: _onCreateIssue }: { onCreateIssue: () => void }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get('status') || '';
  const [issues, setIssues] = useState<AssistantIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [consumer, setConsumer] = useState<any>(null);

  useEffect(() => {
    setLoading(true);
    api.assistantListIssues(status).then((data) => setIssues(data as AssistantIssue[])).catch(console.error).finally(() => setLoading(false));
  }, [status]);

  useEffect(() => {
    fetch('/api/assistant/issues/counts').then(r => r.json()).then(d => {
      setConsumer({ ...d, lastPoll: null });
    }).catch(() => {});
    const interval = setInterval(() => {
      fetch('/api/assistant/issues/counts').then(r => r.json()).then(d => {
        setConsumer((prev: any) => ({ ...prev, ...d }));
      }).catch(() => {});
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="issues-page">
      <div className="issues-page__head">
        <h2>Issues</h2>
        <button className="btn btn--primary btn--sm" onClick={() => navigate('/issues/new')}>
          + New Issue
        </button>
      </div>

      <div className="tab-bar">
        {STATUS_TABS.map(tab => (
          <button
            key={tab.key}
            className={`tab-bar__item${status === tab.key ? ' tab-bar__item--active' : ''}`}
            onClick={() => setSearchParams(tab.key ? { status: tab.key } : {})}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="issues-list">
        {loading && <p className="muted empty-sm">Loading…</p>}
        {!loading && issues.length === 0 && (
          <p className="muted empty-sm">No issues found.</p>
        )}
        {issues.map(issue => (
          <button
            key={issue.id}
            className="issues-card"
            onClick={() => navigate(`/issues/${issue.id}`)}
          >
            <div className="issues-card__top">
              <span className="issues-card__summary">{issue.summary}</span>
              <span className={`badge badge--${issue.status}`}>{issue.status}</span>
            </div>
            <div className="issues-card__meta">
              <span className="muted">{CATEGORY_LABELS[issue.category] || issue.category}</span>
              {issue.resolvedBy && <span className="muted">· resolved by {issue.resolvedBy}</span>}
              {issue.createdAt && <span className="muted">· {timeAgo(issue.createdAt)}</span>}
            </div>
          </button>
        ))}
      </div>

      {consumer && (
        <div className="consumer-bar">
          <span className={`consumer-bar__dot consumer-bar__dot--${consumer.open > 0 ? 'active' : 'idle'}`} />
          <span>Consumer: {consumer.open > 0 ? 'active' : 'idle'}</span>
          {consumer.open > 0 && <span className="muted">· {consumer.open} open</span>}
          <span className="muted">· Auth: OK</span>
        </div>
      )}
    </div>
  );
}
