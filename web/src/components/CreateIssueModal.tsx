import { useState } from 'react';
import { api } from '../api';
import { AppIcon } from '../icons';

interface Props {
  onClose: () => void;
}

const CATEGORIES = ['bug', 'error', 'missing_feature', 'performance', 'security', 'general'] as const;

export function CreateIssueModal({ onClose }: Props) {
  const [summary, setSummary] = useState('');
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('bug');
  const [details, setDetails] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);

  async function submit() {
    if (!summary.trim()) {
      setError('A summary is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.assistantReportIssue(
        summary.trim(),
        category,
        details.trim() ? { description: details.trim() } : undefined,
      );
      setCreated(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h3>
            <AppIcon name="warning" /> Create an issue
          </h3>
          <button className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {created ? (
          <p className="muted">Thanks! Your issue has been recorded.</p>
        ) : (
          <>
            <label className="field">
              <span>Summary</span>
              <input
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="Short one-line description"
                spellCheck={false}
                autoFocus
              />
            </label>

            <label className="field">
              <span>Category</span>
              <select value={category} onChange={(e) => setCategory(e.target.value as (typeof CATEGORIES)[number])}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c.replace('_', ' ')}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Details (optional)</span>
              <textarea
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder="What happened, expected outcome, reproduction steps…"
                rows={4}
              />
            </label>

            {error && <p className="usage__error"><AppIcon name="warning" /> {error}</p>}
          </>
        )}

        <div className="modal__foot">
          <span />
          {created ? (
            <button className="btn btn--primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <button className="btn btn--primary" disabled={submitting || !summary.trim()} onClick={submit}>
              {submitting ? 'Submitting…' : 'Submit issue'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
