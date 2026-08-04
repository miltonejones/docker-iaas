import { useCallback, useEffect, useState } from 'react';
import { AssistantsSettings } from '../components/AssistantsSettings';
import { useAuth } from '../AuthContext';
import { api } from '../api';

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
  const { role } = useAuth();
  const [status, setStatus] = useState<UserSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null);
  const [webhookCopied, setWebhookCopied] = useState(false);
  const [users, setUsers] = useState<Array<{ id: string; email: string; role: string; created_at: string }>>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [apiKeys, setApiKeys] = useState<Array<{ id: string; name: string; key_prefix: string; created_at: string; last_used_at: string | null }>>([]);
  const [apiKeysLoading, setApiKeysLoading] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [apiKeyError, setApiKeyError] = useState('');

  useEffect(() => {
    fetch('/api/auth/settings')
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setError('Failed to load settings.'));

    // Only admins can access webhook and user management.
    if (role === 'admin') {
      fetch('/api/system/webhook-secret')
        .then((r) => r.json())
        .then((d) => setWebhookSecret(d.secret || ''))
        .catch(() => setWebhookSecret(''));

      loadUsers();
    }
  }, [role]);

  async function loadUsers() {
    setUsersLoading(true);
    try {
      const res = await fetch('/api/auth/users');
      if (res.ok) setUsers(await res.json());
    } catch { /* ignore */ }
    setUsersLoading(false);
  }

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

  async function updateUserRole(userId: string, newRole: string) {
    try {
      const res = await fetch(`/api/auth/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to update role.');
        return;
      }
      await loadUsers();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function deleteUserAccount(userId: string, email: string) {
    if (!confirm(`Delete user ${email}? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/auth/users/${userId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to delete user.');
        return;
      }
      await loadUsers();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const loadApiKeys = useCallback(async () => {
    setApiKeysLoading(true);
    setApiKeyError('');
    try {
      const keys = await api.apiKeyList();
      setApiKeys(keys);
    } catch (err) {
      setApiKeyError((err as Error).message);
    }
    setApiKeysLoading(false);
  }, []);

  async function createApiKey() {
    if (!newKeyName.trim()) return;
    setApiKeyError('');
    try {
      const created = await api.apiKeyCreate(newKeyName.trim());
      setNewKeyValue(created.key);
      setNewKeyName('');
      await loadApiKeys();
    } catch (err) {
      setApiKeyError((err as Error).message);
    }
  }

  async function revokeApiKey(id: string) {
    if (!confirm('Revoke this API key? Any client using it will stop working immediately.')) return;
    setApiKeyError('');
    try {
      await api.apiKeyRevoke(id);
      await loadApiKeys();
    } catch (err) {
      setApiKeyError((err as Error).message);
    }
  }

  function copyApiKey(text: string) {
    navigator.clipboard.writeText(text);
  }

  return (
    <SettingsTabbedView
      error={error}
      saved={saved}
      status={status}
      fields={fields}
      saving={saving}
      webhookSecret={webhookSecret}
      webhookCopied={webhookCopied}
      role={role}
      users={users}
      usersLoading={usersLoading}
      apiKeys={apiKeys}
      apiKeysLoading={apiKeysLoading}
      newKeyName={newKeyName}
      newKeyValue={newKeyValue}
      apiKeyError={apiKeyError}
      onSave={handleSave}
      onCopyWebhook={copyWebhook}
      onRotateWebhook={rotateWebhook}
      onUpdateUserRole={updateUserRole}
      onDeleteUser={deleteUserAccount}
      onLoadApiKeys={loadApiKeys}
      onSetNewKeyName={setNewKeyName}
      onCreateApiKey={createApiKey}
      onRevokeApiKey={revokeApiKey}
      onCopyApiKey={copyApiKey}
      onDismissNewKey={() => setNewKeyValue(null)}
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
  role: string | null;
  users: Array<{ id: string; email: string; role: string; created_at: string }>;
  usersLoading: boolean;
  apiKeys: Array<{ id: string; name: string; key_prefix: string; created_at: string; last_used_at: string | null }>;
  apiKeysLoading: boolean;
  newKeyName: string;
  newKeyValue: string | null;
  apiKeyError: string;
  onSave: (e: React.FormEvent<HTMLFormElement>) => void;
  onCopyWebhook: () => void;
  onRotateWebhook: () => void;
  onUpdateUserRole: (userId: string, newRole: string) => void;
  onDeleteUser: (userId: string, email: string) => void;
  onLoadApiKeys: () => void;
  onSetNewKeyName: (v: string) => void;
  onCreateApiKey: () => void;
  onRevokeApiKey: (id: string) => void;
  onCopyApiKey: (text: string) => void;
  onDismissNewKey: () => void;
}) {
  const {
    error, saved, status, fields, saving,
    webhookSecret, webhookCopied,
    role, users, usersLoading,
    apiKeys, apiKeysLoading, newKeyName, newKeyValue, apiKeyError,
    onSave, onCopyWebhook, onRotateWebhook,
    onUpdateUserRole, onDeleteUser,
    onLoadApiKeys, onSetNewKeyName, onCreateApiKey, onRevokeApiKey, onCopyApiKey, onDismissNewKey,
  } = props;

  const SETTINGS_TABS = [
    { key: 'credentials' as const, label: 'Credentials' },
    { key: 'api-keys' as const, label: 'API Keys' },
    { key: 'webhook' as const, label: 'Webhook' },
    { key: 'assistants' as const, label: 'Assistants' },
    ...(role === 'admin' ? [{ key: 'users' as const, label: 'Users' }] : []),
  ];
  type SettingsTab = (typeof SETTINGS_TABS)[number]['key'];

  const [activeTab, setActiveTab] = useState<SettingsTab>('credentials');

  // Load API keys when the tab becomes active.
  useEffect(() => {
    if (activeTab === 'api-keys') onLoadApiKeys();
  }, [activeTab, onLoadApiKeys]);

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

      {activeTab === 'api-keys' && (
        <section className="settings-section" style={{ marginTop: 16 }}>
          <h2>API Keys</h2>
          <p className="muted">
            Create API keys for CLI tools, scripts, and CI/CD pipelines.
            Keys are hashed at rest — you will only see the full key once when you create it.
          </p>

          {apiKeyError && <div className="toast toast--error" style={{ marginTop: 8 }}>{apiKeyError}</div>}

          {newKeyValue && (
            <div className="toast toast--success" style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <strong>Key created — copy it now, it won't be shown again.</strong>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="text"
                  readOnly
                  value={newKeyValue}
                  className="input mono"
                  style={{ flex: 1, fontFamily: 'monospace', fontSize: '13px' }}
                />
                <button type="button" className="btn btn--sm" onClick={() => onCopyApiKey(newKeyValue)}>
                  Copy
                </button>
                <button type="button" className="btn btn--sm" onClick={onDismissNewKey}>
                  Dismiss
                </button>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-end' }}>
            <label className="settings-field" style={{ flex: 1, margin: 0 }}>
              <span className="settings-field__label">Key name</span>
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => onSetNewKeyName(e.target.value)}
                placeholder="e.g. laptop CLI"
                className="input"
                onKeyDown={(e) => { if (e.key === 'Enter') onCreateApiKey(); }}
              />
            </label>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!newKeyName.trim()}
              onClick={onCreateApiKey}
              style={{ marginBottom: 0 }}
            >
              Create key
            </button>
          </div>

          {apiKeysLoading ? (
            <p className="empty-sm" style={{ marginTop: 16 }}>Loading…</p>
          ) : apiKeys.length === 0 ? (
            <p className="empty-sm" style={{ marginTop: 16 }}>No API keys yet.</p>
          ) : (
            <table className="data-table" style={{ width: '100%', marginTop: 16 }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {apiKeys.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td className="mono" style={{ fontFamily: 'monospace', fontSize: '13px' }}>{k.key_prefix}</td>
                    <td className="muted" style={{ fontSize: '13px' }}>{new Date(k.created_at).toLocaleDateString()}</td>
                    <td className="muted" style={{ fontSize: '13px' }}>
                      {k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'never'}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--sm btn--danger"
                        onClick={() => onRevokeApiKey(k.id)}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
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

      {activeTab === 'users' && (
        <section className="settings-section" style={{ marginTop: 16 }}>
          <h2>Users</h2>
          {usersLoading ? (
            <p className="empty-sm">Loading…</p>
          ) : users.length === 0 ? (
            <p className="empty-sm">No users found.</p>
          ) : (
            <table className="data-table" style={{ width: '100%', marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.email}</td>
                    <td>
                      <select
                        value={u.role}
                        onChange={(e) => onUpdateUserRole(u.id, e.target.value)}
                        className="input input--sm"
                      >
                        <option value="admin">admin</option>
                        <option value="operator">operator</option>
                        <option value="viewer">viewer</option>
                      </select>
                    </td>
                    <td className="muted" style={{ fontSize: '13px' }}>{new Date(u.created_at).toLocaleDateString()}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--sm btn--danger"
                        onClick={() => onDeleteUser(u.id, u.email)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {activeTab === 'assistants' && <AssistantsSettings />}
    </div>
  );
}
