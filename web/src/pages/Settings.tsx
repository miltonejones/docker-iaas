import { useEffect, useState } from 'react';

interface SettingStatus {
  configured: boolean;
}

type UserSettings = Record<string, SettingStatus>;

const FIELD_LABELS: Record<string, string> = {
  anthropic_api_key: 'Anthropic API key',
  deepseek_api_key: 'DeepSeek API key',
  github_token: 'GitHub personal access token',
  aws_access_key_id: 'AWS access key ID',
  aws_secret_access_key: 'AWS secret access key',
  assistant_provider: 'Assistant provider',
};

const FIELD_PLACEHOLDERS: Record<string, string> = {
  anthropic_api_key: 'sk-ant-...',
  deepseek_api_key: 'sk-...',
  github_token: 'ghp_...',
  aws_access_key_id: 'AKIA...',
  aws_secret_access_key: '',
  assistant_provider: 'anthropic',
};

export function SettingsPage() {
  const [status, setStatus] = useState<UserSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/auth/settings')
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setError('Failed to load settings.'));
  }, []);

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const form = new FormData(e.currentTarget);
    const body: Record<string, string | null> = {};
    for (const key of Object.keys(FIELD_LABELS)) {
      const val = form.get(key) as string;
      body[key] = val || null;
    }
    try {
      const res = await fetch('/api/auth/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Save failed');
      // Refresh status after save
      const updated = await fetch('/api/auth/settings').then((r) => r.json());
      setStatus(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!status) return <div className="page"><p>Loading…</p></div>;

  const fields = Object.keys(FIELD_LABELS);

  return (
    <div className="page">
      <h1>Settings</h1>
      <p className="muted">Configure your API keys and credentials. They are encrypted at rest and never returned in plaintext.</p>

      {error && <div className="toast toast--error">{error}</div>}
      {saved && <div className="toast toast--success">Settings saved.</div>}

      <form onSubmit={handleSave} className="settings-form">
        {fields.map((key) => {
          const configured = status[key]?.configured ?? false;
          const isSecret = key !== 'assistant_provider';
          return (
            <label key={key} className="settings-field">
              <span className="settings-field__label">
                {FIELD_LABELS[key]}
                {configured && <span className="badge badge--ok" style={{ marginLeft: 8 }}>configured</span>}
              </span>
              {isSecret ? (
                <input
                  type="password"
                  name={key}
                  defaultValue=""
                  placeholder={configured ? '(unchanged)' : FIELD_PLACEHOLDERS[key]}
                  className="input"
                  autoComplete="off"
                />
              ) : (
                <select name={key} defaultValue="" className="input">
                  <option value="">System default</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="deepseek">DeepSeek</option>
                </select>
              )}
            </label>
          );
        })}
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </form>
    </div>
  );
}
