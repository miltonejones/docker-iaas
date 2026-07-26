import { useEffect, useState } from 'react';

interface UserSettings {
  anthropic_api_key: string | null;
  deepseek_api_key: string | null;
  github_token: string | null;
  aws_access_key_id: string | null;
  aws_secret_access_key: string | null;
  assistant_provider: string | null;
}

const FIELD_LABELS: Record<keyof UserSettings, string> = {
  anthropic_api_key: 'Anthropic API key',
  deepseek_api_key: 'DeepSeek API key',
  github_token: 'GitHub personal access token',
  aws_access_key_id: 'AWS access key ID',
  aws_secret_access_key: 'AWS secret access key',
  assistant_provider: 'Assistant provider',
};

const FIELD_PLACEHOLDERS: Record<keyof UserSettings, string> = {
  anthropic_api_key: 'sk-ant-...',
  deepseek_api_key: 'sk-...',
  github_token: 'ghp_...',
  aws_access_key_id: 'AKIA...',
  aws_secret_access_key: '',
  assistant_provider: 'anthropic',
};

function maskValue(value: string | null): string {
  if (!value) return '';
  if (value.length <= 6) return '••••••';
  return value.slice(0, 4) + '••••' + value.slice(-4);
}

export function SettingsPage() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetch('/api/auth/settings')
      .then((r) => r.json())
      .then(setSettings)
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
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return <div className="page"><p>Loading…</p></div>;

  const fields = Object.keys(FIELD_LABELS) as (keyof UserSettings)[];

  return (
    <div className="page">
      <h1>Settings</h1>
      <p className="muted">Configure your API keys and credentials. They are encrypted at rest.</p>

      {error && <div className="toast toast--error">{error}</div>}
      {saved && <div className="toast toast--success">Settings saved.</div>}

      <form onSubmit={handleSave} className="settings-form">
        {fields.map((key) => {
          const value = settings[key] ?? '';
          const isSecret = key !== 'assistant_provider';
          return (
            <label key={key} className="settings-field">
              <span className="settings-field__label">{FIELD_LABELS[key]}</span>
              {isSecret ? (
                <div className="settings-field__secret">
                  <input
                    type={reveal[key] ? 'text' : 'password'}
                    name={key}
                    defaultValue={value}
                    placeholder={FIELD_PLACEHOLDERS[key]}
                    className="input"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setReveal((r) => ({ ...r, [key]: !r[key] }))}
                  >
                    {reveal[key] ? 'Hide' : 'Show'}
                  </button>
                </div>
              ) : (
                <select name={key} defaultValue={value || 'anthropic'} className="input">
                  <option value="anthropic">Anthropic</option>
                  <option value="deepseek">DeepSeek</option>
                </select>
              )}
              {isSecret && value && (
                <span className="settings-field__hint">
                  {reveal[key] ? '' : maskValue(value)}
                </span>
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
