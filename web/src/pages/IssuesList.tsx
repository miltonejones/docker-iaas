import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { AssistantIssue } from '../types';
import { timeAgo } from '../format';
import { onRefresh } from '../refresh';

const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'closed', label: 'Closed' },
];

const CATEGORY_LABELS: Record<string, string> = {
  bug: 'Bug',
  error: 'Error',
  missing_feature: 'Missing Feature',
  performance: 'Performance',
  security: 'Security',
  general: 'General',
};

interface Props {
  onCreateIssue: () => void;
}

export function IssuesPage({ onCreateIssue }: Props) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get('status') || '';
  const [issues, setIssues] = useState<AssistantIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [consumer, setConsumer] = useState<any>(null);

  const loadIssues = useCallback(async () => {
    try {
      setLoading(true);
      setIssues(await api.assistantListIssues(status));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { loadIssues(); }, [loadIssues]);

  // Reload when the assistant mutates issues (create/resolve/close).
  useEffect(() => onRefresh(loadIssues), [loadIssues]);

  useEffect(() => {
    fetch('/api/assistant/issues/counts').then(r => r.json()).then(d => {
      setConsumer({ ...d, lastPoll: null });
    }).catch(() => {});
    const interval = setInterval(() => {
      fetch('/api/assistant/issues/counts').then(r => r.json()).then(d => {
        setConsumer(prev => ({ ...prev, ...d }));
      }).catch(() => {});
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Issues <span className="count">{issues.length}</span></h2>
        <button className="btn btn--primary btn--sm" onClick={onCreateIssue}>
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

      {loading && <p className="muted empty-sm">Loading…</p>}
      {!loading && issues.length === 0 && (
        <p className="empty">No issues found.</p>
      )}
      {issues.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Summary</th>
                <th>Category</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {issues.map(issue => (
                <tr key={issue.id} onClick={() => navigate(`/issues/${issue.id}`)}>
                  <td>{issue.summary}</td>
                  <td className="muted">{CATEGORY_LABELS[issue.category] || issue.category}</td>
                  <td>
                    <span className={`badge badge--${issue.status}`}>{issue.status.replace('_', ' ')}</span>
                  </td>
                  <td className="muted">{issue.createdAt ? timeAgo(new Date(issue.createdAt).getTime() / 1000) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {consumer && (
        <div className="consumer-bar">
          <span className={`consumer-bar__dot consumer-bar__dot--${consumer.open > 0 ? 'active' : 'idle'}`} />
          <span>Consumer: {consumer.open > 0 ? 'active' : 'idle'}</span>
          {consumer.open > 0 && <span className="muted">· {consumer.open} open</span>}
          <span className="muted">· Auth: OK</span>
        </div>
      )}
    </section>
  );
}
