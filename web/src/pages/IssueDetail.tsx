import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { AssistantIssue } from '../types';
import { onRefresh } from '../refresh';

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  needs_review: 'Needs Review',
  deploying: 'Deploying',
  resolved: 'Resolved',
  closed: 'Closed',
};

interface ActivityEntry {
  id: string;
  summary: string;
  exitCode: number | null;
  outcome: string;
  commitSha?: string;
  commitUrl?: string;
}

function formatDate(ts: string) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function IssueDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [issue, setIssue] = useState<AssistantIssue | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [editing, setEditing] = useState(false);
  const [editSummary, setEditSummary] = useState('');
  const [editDetails, setEditDetails] = useState('');
  const [loading, setLoading] = useState(true);

  const loadIssue = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const issueData = await api.assistantGetIssue(id);
      setIssue(issueData);
    } catch {
      setIssue(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadIssue(); }, [loadIssue]);

  // Reload when the assistant mutates this issue.
  useEffect(() => onRefresh(loadIssue), [loadIssue]);

  // Fetch consumer activity for this issue
  useEffect(() => {
    if (!id) return;
    fetch('/api/assistant/issues/activity').then(r => r.json()).then(data => {
      if (Array.isArray(data)) {
        setActivity(data.filter((a: ActivityEntry) => a.id === id));
      }
    }).catch(() => {});
  }, [id]);

  if (loading) return <p className="muted empty-sm">Loading…</p>;
  if (!issue) return <p className="muted empty-sm">Issue not found.</p>;

  const details = issue.details && typeof issue.details === 'object'
    ? (issue.details as Record<string, unknown>)
    : {};

  return (
    <section className="panel">
      <button className="btn btn--ghost btn--sm issue-detail__back" onClick={() => navigate('/issues')}>
        ← Back to issues
      </button>

      <div className="issue-detail__header">
        <code className="issue-detail__id">{issue.id}</code>
        <h2>{issue.summary}</h2>
        <div className="issue-detail__badges">
          <span className="badge">{issue.category?.replace('_', ' ')}</span>
          <span className={`badge badge--${issue.status}`}>{STATUS_LABELS[issue.status] || issue.status}</span>
        </div>
        <div className="issue-detail__meta muted">
          <span>Created: {formatDate(issue.createdAt)}</span>
          {issue.resolvedBy && <span> · Resolved by: {issue.resolvedBy}</span>}
        </div>
      </div>

      {editing ? (
        <section className="issue-detail__section">
          <label>Summary</label>
          <input
            className="input"
            value={editSummary}
            onChange={(e) => setEditSummary(e.target.value)}
            placeholder="Issue summary"
          />
          <label style={{ marginTop: 12 }}>Details (JSON)</label>
          <textarea
            className="input"
            rows={4}
            value={editDetails}
            onChange={(e) => setEditDetails(e.target.value)}
            placeholder='{"key": "value"}'
          />
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className="btn btn--sm btn--primary" onClick={async () => {
              let parsed = {};
              try { parsed = JSON.parse(editDetails || '{}'); } catch { /* invalid */ }
              const updated = await api.assistantUpdateIssue(issue.id, {
                summary: editSummary,
                details: parsed,
              });
              setIssue(updated);
              setEditing(false);
            }}>Save</button>
            <button className="btn btn--sm btn--ghost" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </section>
      ) : (
        <div className="issue-detail__actions" style={{ marginTop: 0 }}>
          <button className="btn btn--sm btn--ghost" onClick={() => {
            setEditSummary(issue.summary);
            setEditDetails(JSON.stringify(details, null, 2));
            setEditing(true);
          }}>Edit Issue</button>
        </div>
      )}

      {Object.keys(details).length > 0 && (
        <section className="issue-detail__section">
          <h3>Details</h3>
          {Object.entries(details).map(([key, value]) => (
            <div key={key}>
              <strong>{key.replace(/_/g, ' ')}</strong>
              <p className="muted">{typeof value === 'string' ? value : JSON.stringify(value)}</p>
            </div>
          ))}
        </section>
      )}

      {issue.resolution && (
        <section className="issue-detail__section">
          <h3>Resolution</h3>
          <p>{issue.resolution}</p>
          <span className="muted">Resolved by: {issue.resolvedBy}</span>
        </section>
      )}

      {activity.length > 0 && (
        <section className="issue-detail__section">
          <h3>Consumer Activity</h3>
          <div className="activity-timeline">
            {activity.map((a, i) => (
              <div key={i} className="activity-timeline__row">
                <span className={`activity-timeline__dot activity-timeline__dot--${a.outcome}`} />
                <span className="activity-timeline__label">
                  {a.outcome === 'fixed' ? 'Fixed' : 'Failed'}
                  {a.exitCode !== null && ` (exit ${a.exitCode})`}
                </span>
                {a.commitUrl && (
                  <a href={a.commitUrl} target="_blank" rel="noreferrer" className="btn btn--ghost btn--sm">
                    View commit on GitHub ↗
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="issue-detail__actions">
        {issue.status !== 'open' && (
          <button
            className="btn btn--primary btn--sm"
            onClick={() => api.assistantUpdateIssue(issue.id, { status: 'open', resolution: undefined, resolvedBy: undefined }).then(() => setIssue({ ...issue, status: 'open' }))}
          >
            Re-open Issue
          </button>
        )}
        {issue.status !== 'closed' && (
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => api.assistantUpdateIssue(issue.id, { status: 'closed' }).then(() => setIssue({ ...issue, status: 'closed' }))}
          >
            Close Issue
          </button>
        )}
      </div>
    </section>
  );
}
