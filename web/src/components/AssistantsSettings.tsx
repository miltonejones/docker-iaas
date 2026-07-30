import { useEffect, useState } from 'react';
import type { UserAssistant } from '../types';
import { api } from '../api';
import { AppIcon } from '../icons';

const TOOL_CATEGORIES: { label: string; tools: string[] }[] = [
  {
    label: 'Containers',
    tools: [
      'list_containers', 'launch_container', 'container_action',
      'inspect_container', 'get_container_logs', 'write_container_file',
      'write_container_files', 'replace_in_container_file', 'read_container_file',
      'list_container_files', 'execute_container_command',
      'get_container_exec_output', 'probe_container_endpoint',
      'update_container_env', 'delete_container',
    ],
  },
  {
    label: 'Functions',
    tools: [
      'list_functions', 'create_lambda_function', 'read_function',
      'update_lambda_function', 'delete_lambda_function',
      'run_function', 'replace_lambda_function_files',
    ],
  },
  {
    label: 'Gateway & DNS',
    tools: [
      'list_gateway_routes', 'create_gateway_route', 'update_gateway_route',
      'delete_gateway_route', 'check_gateway_domain_status',
      'set_gateway_domain', 'enable_gateway_domain', 'remove_gateway_domain',
      'list_dns_zones', 'list_dns_records', 'create_dns_record', 'delete_dns_record',
    ],
  },
  {
    label: 'Buckets',
    tools: [
      'list_buckets', 'create_bucket', 'delete_bucket', 'update_bucket',
      'list_bucket_objects', 'read_bucket_object', 'write_bucket_object',
      'write_bucket_objects', 'replace_in_bucket_object', 'delete_bucket_object',
      'copy_host_file_to_bucket',
    ],
  },
  {
    label: 'Images',
    tools: ['list_images', 'delete_image', 'prune_images', 'prune_build_cache'],
  },
  {
    label: 'Database',
    tools: [
      'list_database_connections', 'get_database_connection',
      'get_database_operations_overview', 'inspect_database_schema',
      'run_database_read_query', 'test_database_connection',
      'create_database_connection', 'update_database_connection',
      'delete_database_connection', 'execute_database_mutation',
      'execute_database_migration', 'execute_database_access_grant',
      'create_database_backup', 'restore_database_backup',
      'list_database_jobs', 'get_database_job',
    ],
  },
  {
    label: 'Projects',
    tools: ['list_projects', 'create_project', 'update_project', 'delete_project'],
  },
  {
    label: 'GitHub',
    tools: [
      'get_github_workflow_status', 'list_github_repo_files',
      'read_github_file', 'pull_github_repo_to_bucket',
      'pull_github_repo_to_container', 'commit_and_push_github_files',
    ],
  },
  {
    label: 'Host & System',
    tools: [
      'list_presets', 'list_used_ports', 'list_images', 'system_ping',
      'list_volumes', 'list_host_directory', 'read_host_file',
      'list_host_build_presets', 'run_host_build_preset',
      'copy_host_file_to_container',
    ],
  },
  {
    label: 'Issues',
    tools: ['list_issues', 'get_issue', 'report_issue', 'update_issue', 'delete_issue', 'clear_issues'],
  },
];

const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse'];

const ASSISTANT_ICONS = [
  '🛠️', '🔧', '⚙️', '🚀', '🐳', '☁️', '🌐', '💻', '🖥️', '📱',
  '🔒', '🔑', '📊', '📈', '🔍', '📋', '📦', '🏷️', '🎯', '⚡',
  '🔥', '❄️', '💾', '🗄️', '🏗️', '🧱', '🚦', '🛡️', '🤖', '🧠',
  '🧪', '🔬', '📡', '🌍', '🚢', '✈️', '🔔', '❤️', '💵', '🎉',
  '🧹', '🗂️', '📁', '🧰', '🏭', '🛳️', '🪝', '🔗', '🎨', '💡',
];

/** The avatar slot renders a single grapheme, so clamp free-text input to the
 *  first grapheme a user types or pastes (handles multi-char emoji sequences and
 *  accidental multi-character pastes). The picker already selects one emoji. */
function firstGrapheme(s: string): string {
  if (!s) return '';
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const g of seg.segment(s)) return g.segment;
    return s[0] ?? '';
  } catch {
    return Array.from(s)[0] ?? '';
  }
}

export function AssistantsSettings() {
  const [assistants, setAssistants] = useState<UserAssistant[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // New/edit form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [toolList, setToolList] = useState<string[]>([]);
  const [voice, setVoice] = useState('alloy');
  const [icon, setIcon] = useState<string | null>(null);
  const [isDefault, setIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [iconPickerOpen, setIconPickerOpen] = useState(false);

  function load() {
    api.assistantList().then(setAssistants).catch(() => {}).finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  function resetForm() {
    setName('');
    setDescription('');
    setSystemPrompt('');
    setToolList([]);
    setVoice('alloy');
    setIcon(null);
    setIsDefault(false);
    setEditingId(null);
    setIconPickerOpen(false);
    setError('');
  }

  function startEdit(a: UserAssistant) {
    setName(a.name);
    setDescription(a.description);
    setSystemPrompt(a.systemPrompt);
    setToolList(a.toolList);
    setVoice(a.voice);
    setIcon(a.icon);
    setIsDefault(a.isDefault);
    setEditingId(a.id);
    setIconPickerOpen(false);
    setError('');
  }

  function toggleTool(name: string) {
    setToolList((prev) =>
      prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name],
    );
  }

  function toggleCategory(tools: string[]) {
    setToolList((prev) => {
      const allSelected = tools.every((t) => prev.includes(t));
      if (allSelected) return prev.filter((t) => !tools.includes(t));
      return [...new Set([...prev, ...tools])];
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required.'); return; }
    setSaving(true);
    setError('');
    try {
      const body = { name: name.trim(), description: description.trim(), systemPrompt: systemPrompt.trim(), toolList, voice, icon: icon || undefined, isDefault };
      if (editingId) {
        await api.assistantUpdate(editingId, body);
      } else {
        await api.assistantCreate(body);
        resetForm();
      }
      load();
      if (editingId) resetForm();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this assistant?')) return;
    try {
      await api.assistantDelete(id);
      if (editingId === id) resetForm();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="settings-section">
      <h2><AppIcon name="assistant" /> Assistants</h2>
      <p className="muted">
        Create custom assistants with their own tool sets and system prompts.
        Each assistant can be selected from the chat bar or invoked with <code>@name</code>.
      </p>

      {error && <div className="toast toast--error">{error}</div>}

      <div className="assistants-layout">
        {/* Left: assistant list */}
        <div className="assistants-list panel">
          <div className="panel__head">
            <h3>Your assistants</h3>
            <button className="btn btn--primary btn--sm" onClick={resetForm}>
              <AppIcon name="plus" /> New
            </button>
          </div>
          {loading ? (
            <p className="muted">Loading…</p>
          ) : assistants.length === 0 ? (
            <p className="muted empty">No custom assistants yet. Create one above.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {assistants.map((a) => (
                    <tr key={a.id} className={editingId === a.id ? 'row--active' : ''} onClick={() => startEdit(a)}>
                      <td>
                        {a.icon && <span style={{ marginRight: 6 }}>{a.icon}</span>}
                        <strong>{a.name}</strong>
                        {a.isDefault && <span className="badge badge--ok" style={{ marginLeft: 6 }}>default</span>}
                        <br /><span className="muted" style={{ fontSize: 12 }}>{a.description || 'No description'}</span>
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>{a.toolList.length} tools</td>
                      <td>
                        <button className="btn btn--ghost btn--sm" onClick={(e) => { e.stopPropagation(); handleDelete(a.id); }}>
                          <AppIcon name="trash" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right: edit/create form */}
        <div className="assistants-editor panel">
          <div className="panel__head">
            <h3>{editingId ? 'Edit assistant' : 'New assistant'}</h3>
          </div>
          <form onSubmit={handleSubmit} className="settings-form" style={{ padding: 12 }}>
            <label className="settings-field">
              <span className="settings-field__label">Name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. DevOps, UI Designer" autoFocus />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Icon</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input className="input" value={icon ?? ''} onChange={(e) => setIcon(firstGrapheme(e.target.value) || null)} placeholder="🛠️" style={{ width: 48, textAlign: 'center', fontSize: 18 }} />
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setIconPickerOpen(!iconPickerOpen)}>
                  {icon ? icon : 'Pick'}
                </button>
                {icon && <button type="button" className="btn btn--ghost btn--sm" onClick={() => setIcon(null)} style={{ fontSize: 12 }}>✕</button>}
              </div>
              {iconPickerOpen && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6, maxWidth: 320, background: 'var(--bg-alt)', padding: 8, borderRadius: 6 }}>
                  {ASSISTANT_ICONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => { setIcon(emoji); setIconPickerOpen(false); }}
                      style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', border: icon === emoji ? '2px solid var(--accent)' : '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', cursor: 'pointer', fontSize: 16 }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Description (used for auto-routing)</span>
              <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. CI/CD, deployments, GitHub, builds" />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">System prompt</span>
              <textarea className="input" rows={4} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="Override the default system prompt…" />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Voice</span>
              <select className="input" value={voice} onChange={(e) => setVoice(e.target.value)}>
                {VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="settings-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
              <span>Set as default assistant</span>
            </label>

            {/* Tool picker */}
            <div className="settings-field">
              <span className="settings-field__label">Tools ({toolList.length} selected)</span>
              <div className="tool-picker">
                {TOOL_CATEGORIES.map((cat) => {
                  const catSelected = cat.tools.filter((t) => toolList.includes(t)).length;
                  return (
                    <details key={cat.label} className="tool-category">
                      <summary>
                        <input
                          type="checkbox"
                          checked={cat.tools.every((t) => toolList.includes(t))}
                          onChange={(e) => { e.stopPropagation(); toggleCategory(cat.tools); }}
                          style={{ margin: 0 }}
                        />
                        <span>{cat.label}</span>
                        <span className="muted" style={{ fontSize: 11 }}>({catSelected}/{cat.tools.length})</span>
                      </summary>
                      <div className="tool-category__list">
                        {cat.tools.map((t) => (
                          <label key={t} className="tool-chip">
                            <input type="checkbox" checked={toolList.includes(t)} onChange={() => toggleTool(t)} />
                            <span>{t}</span>
                          </label>
                        ))}
                      </div>
                    </details>
                  );
                })}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" className="btn btn--primary" disabled={saving}>
                {saving ? 'Saving…' : editingId ? 'Update' : 'Create'}
              </button>
              {editingId && <button type="button" className="btn btn--ghost" onClick={resetForm}>Cancel</button>}
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}
