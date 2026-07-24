import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { AppIcon } from '../icons';
import type { AssistantIssue } from '../types';

const PAGE_SIZE = 10;

const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'needs_review', label: 'Needs Review' },
  { key: 'deploying', label: 'Deploying' },
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

type ConsumerState = {
  state: string;
  currentIssue?: { id: string; summary: string };
  authOk: boolean;
  lastPoll: string;
  lastError: string | null;
};

export function IssuesPage({ onCreateIssue }: { onCreateIssue: () => void }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get('status') || '';
  const [issues, setIssues] = useState<AssistantIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [consumer, setConsumer] = useState<ConsumerState | null>(null);
  const [page, setPage] = useState(0);

  useEffect(() => {
    setLoading(true);
    setPage(0);
    api.assistantListIssues(status).then((data) => setIssues(data as AssistantIssue[])).catch(console.error).finally(() => setLoading(false));
  }, [status]);

  useEffect(() => {
    const poll = () => {
      api.consumerStatus().then(setConsumer).catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 10_000);
    return () => clearInterval(interval);
  }, []);

  const totalPages = Math.max(1, Math.ceil(issues.length / PAGE_SIZE));
  const paginatedIssues = useMemo(
    () => issues.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [issues, page],
  );

  // Clamp page if the filtered list shrinks (e.g. status filter changed).
  useEffect(() => {
    if (page >= totalPages) setPage(Math.max(0, totalPages - 1));
  }, [page, totalPages]);

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Issues <span className="count">{issues.length}</span></h2>
        <div className="panel__head-actions">
          <label className="filter-bar__label" htmlFor="status-filter">
            <AppIcon name="filter" /> Status:
          </label>
          <select
            id="status-filter"
            className="input"
            value={status}
            onChange={(e) => setSearchParams(e.target.value ? { status: e.target.value } : {})}
          >
            {STATUS_TABS.map(tab => (
              <option key={tab.key} value={tab.key}>{tab.label}</option>
            ))}
          </select>
          <button className="btn btn--primary btn--sm" onClick={() => onCreateIssue()}>
            + New Issue
          </button>
        </div>
      </div>

      {loading && <p className="muted empty-sm">Loading…</p>}
      {!loading && issues.length === 0 && (
        <p className="empty">No issues found.</p>
      )}
      {!loading && issues.length > 0 && (
        <>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Summary</th>
                <th>Category</th>
                <th>Status</th>
                <th>Reported</th>
              </tr>
            </thead>
            <tbody>
              {paginatedIssues.map(issue => (
                <tr
                  key={issue.id}
                  onClick={() => navigate(`/issues/${issue.id}`)}
                >
                  <td><AppIcon name="bug" /> {issue.summary}</td>
                  <td><span className="chip">{CATEGORY_LABELS[issue.category] || issue.category}</span></td>
                  <td><span className={`badge badge--${issue.status}`}>{issue.status}</span></td>
                  <td className="muted">{issue.createdAt ? timeAgo(issue.createdAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="pagination">
            <button
              className="btn btn--sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              ← Previous
            </button>
            <span className="pagination__info">
              Page {page + 1} of {totalPages}
            </span>
            <button
              className="btn btn--sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              Next →
            </button>
          </div>
        )}
        </>
      )}

      {consumer && (
        <div className="consumer-bar">
          <span className={`consumer-bar__dot consumer-bar__dot--${consumer.state === 'idle' ? 'idle' : consumer.state === 'processing' ? 'active' : 'error'}`} />
          <span>Consumer: {consumer.state}</span>
          {consumer.currentIssue && (
            <span className="muted">· <a href={`/issues/${consumer.currentIssue.id}`} className="link">{consumer.currentIssue.summary}</a></span>
          )}
          {consumer.lastPoll && <span className="muted">· polled {timeAgo(consumer.lastPoll)}</span>}
          {!consumer.authOk && <span className="muted" style={{ color: 'var(--danger)' }}>· Auth: FAIL</span>}
          {consumer.lastError && <span className="muted" style={{ color: 'var(--danger)' }}>· {consumer.lastError.slice(0, 80)}</span>}
        </div>
      )}
    </section>
  );
}
