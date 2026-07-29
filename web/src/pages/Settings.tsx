import { useEffect, useState } from 'react';
import { AssistantsSettings } from '../components/AssistantsSettings';

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
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null);
  const [webhookCopied, setWebhookCopied] = useState(false);

  useEffect(() => {
    fetch('/api/auth/settings')
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setError('Failed to load settings.'));

    fetch('/api/system/webhook-secret')
      .then((r) => r.json())
      .then((d) => setWebhookSecret(d.secret || ''))
      .catch(() => {
        setWebhookSecret('');
        setError('Failed to load webhook secret.');
      });
  }, []);

  async function rotateWebhook() {
    if (!confirm('This will invalidate the current webhook secret and break any CI/CD pipeline using it. Continue?')) return;
    try {
      const res = await fetch('/api/system/webhook-secret/rotate', { method: 'POST' });
      if (!res.ok) throw new Error('Rotate failed');
      const data = await res.json();
      setWebhookSecret(data.secret);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function copyWebhook() {
    if (!webhookSecret) return;
    navigator.clipboard.writeText(webhookSecret);
    setWebhookCopied(true);
    setTimeout(() => setWebhookCopied(false), 2000);
  }

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
    <SettingsTabbedView
      error={error}
      saved={saved}
      status={status}
      fields={fields}
      saving={saving}
      webhookSecret={webhookSecret}
      webhookCopied={webhookCopied}
      onSave={handleSave}
      onCopyWebhook={copyWebhook}
      onRotateWebhook={rotateWebhook}
    />
  );
}

function SettingsTabbedView(props: {
  error: string;
  saved: boolean;
  status: UserSettings;
  fields: string[];
  saving: boolean;
  webhookSecret: string | null;
  webhookCopied: boolean;
  onSave: (e: React.FormEvent<HTMLFormElement>) => void;
  onCopyWebhook: () => void;
  onRotateWebhook: () => void;
}) {
  const {
    error, saved, status, fields, saving,
    webhookSecret, webhookCopied,
    onSave, onCopyWebhook, onRotateWebhook,
  } = props;

  const SETTINGS_TABS = [
    { key: 'credentials' as const, label: 'Credentials' },
    { key: 'webhook' as const, label: 'Webhook' },
    { key: 'assistants' as const, label: 'Assistants' },
  ];
  type SettingsTab = (typeof SETTINGS_TABS)[number]['key'];

  const [activeTab, setActiveTab] = useState<SettingsTab>('credentials');

  return (
    <div className="page">
      <h1>Settings</h1>
      <p className="muted">Configure your API keys and credentials. They are encrypted at rest and never returned in plaintext.</p>

      <div className="tab-bar" style={{ marginTop: 16 }}>
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`tab-bar__item${activeTab === t.key ? ' tab-bar__item--active' : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="toast toast--error" style={{ marginTop: 16 }}>{error}</div>}
      {saved && <div className="toast toast--success" style={{ marginTop: 16 }}>Settings saved.</div>}

      {activeTab === 'credentials' && (
        <form onSubmit={onSave} className="settings-form" style={{ marginTop: 16 }}>
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
      )}

      {activeTab === 'webhook' && (
        <section className="settings-section">
          <h2>Webhook Secret</h2>
          <p className="muted">
            Used by CI/CD pipelines to authenticate requests to Dockyard's GitHub API endpoints.
            Include this value in the <code>x-webhook-secret</code> header.
          </p>
          {webhookSecret === null ? (
            <p className="empty-sm">Loading…</p>
          ) : webhookSecret ? (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '0.5rem' }}>
              <input
                type="text"
                readOnly
                value={webhookSecret}
                className="input mono"
                style={{ flex: 1, fontFamily: 'monospace', fontSize: '13px' }}
              />
              <button type="button" className="btn btn--sm" onClick={onCopyWebhook}>
                {webhookCopied ? 'Copied!' : 'Copy'}
              </button>
              <button type="button" className="btn btn--sm btn--danger" onClick={onRotateWebhook}>
                Rotate
              </button>
            </div>
          ) : (
            <p className="empty-sm">Loading…</p>
          )}
        </section>
      )}

      {activeTab === 'assistants' && <AssistantsSettings />}
    </div>
  );
}
