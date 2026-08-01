import { useEffect, useState } from 'react';
import type { UserAssistant } from '../types';
import { api } from '../api';
import { AppIcon } from '../icons';

interface ToolMeta {
  name: string;
  description: string;
  category: string;
  readOnly: boolean;
}

const ASSISTANT_ICONS = [
  '🛠️', '🔧', '⚙️', '🚀', '🐳', '☁️', '🌐', '💻', '🖥️', '📱',
  '🔒', '🔑', '📊', '📈', '🔍', '📋', '📦', '🏷️', '🎯', '⚡',
  '🔥', '❄️', '💾', '🗄️', '🏗️', '🧱', '🚦', '🛡️', '🤖', '🧠',
  '🧪', '🔬', '📡', '🌍', '🚢', '✈️', '🔔', '❤️', '💵', '🎉',
  '🧹', '🗂️', '📁', '🧰', '🏭', '🛳️', '🪝', '🔗', '🎨', '💡',
];

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
  const [toolMeta, setToolMeta] = useState<ToolMeta[]>([]);
  const [alwaysIncluded, setAlwaysIncluded] = useState<string[]>([]);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [toolList, setToolList] = useState<string[]>([]);
  const [voice, setVoice] = useState('alloy');
  const [icon, setIcon] = useState<string | null>(null);
  const [isDefault, setIsDefault] = useState(false);
  const [promptMode, setPromptMode] = useState<'append' | 'replace'>('append');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [iconPickerOpen, setIconPickerOpen] = useState(false);

  function load() {
    Promise.all([
      api.assistantList(),
      api.assistantMeta().catch(() => ({ tools: [] as ToolMeta[], alwaysIncluded: [] as string[] })),
    ]).then(([list, meta]) => {
      setAssistants(list);
      setToolMeta(meta.tools);
      setAlwaysIncluded(meta.alwaysIncluded);
    }).catch(() => {}).finally(() => setLoading(false));
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
    setPromptMode('append');
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
    setPromptMode((a as any).promptMode || 'append');
    setEditingId(a.id);
    setIconPickerOpen(false);
    setError('');
  }

  function toggleTool(tname: string) {
    if (alwaysIncluded.includes(tname)) return;
    setToolList((prev) =>
      prev.includes(tname) ? prev.filter((t) => t !== tname) : [...prev, tname],
    );
  }

  function toggleCategory(tools: string[]) {
    const togglable = tools.filter((t) => !alwaysIncluded.includes(t));
    setToolList((prev) => {
      const allSelected = togglable.every((t) => prev.includes(t));
      if (allSelected) return prev.filter((t) => !togglable.includes(t));
      return [...new Set([...prev, ...togglable])];
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required.'); return; }
    setSaving(true);
    setError('');
    try {
      const body = { name: name.trim(), description: description.trim(), systemPrompt: systemPrompt.trim(), toolList, voice, icon: icon || undefined, isDefault, promptMode };
      if (editingId) {
        await api.assistantUpdate(editingId, body as any);
      } else {
        await api.assistantCreate(body as any);
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

  const categories = [...new Set(toolMeta.map((t) => t.category))].sort();

  return (
    <section className="settings-section">
      <h2><AppIcon name="assistant" /> Assistants</h2>
      <p className="muted">
        Create custom assistants with their own tool sets and system prompts.
        Each assistant can be selected from the chat bar or invoked with <code>@name</code>.
      </p>

      {error && <div className="toast toast--error">{error}</div>}

      <div className="assistants-layout">
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
                    <button key={emoji} type="button" onClick={() => { setIcon(emoji); setIconPickerOpen(false); }}
                      style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', border: icon === emoji ? '2px solid var(--accent)' : '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', cursor: 'pointer', fontSize: 16 }}>
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </label>
            <label className="settings-field">
              <span className="settings-field__label">Description</span>
              <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. CI/CD, deployments, GitHub, builds" />
            </label>
            <label className="settings-field">
              <span className="settings-field__label">System prompt</span>
              <textarea className="input" rows={4} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="Override the default system prompt…" />
            </label>
            <div className="settings-field">
              <span className="settings-field__label">Prompt mode</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginTop: 4 }}>
                <input type="radio" name="promptMode" value="append" checked={promptMode === 'append'} onChange={() => setPromptMode('append')} />
                <span>Add to the built-in prompt (recommended)</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginTop: 4 }}>
                <input type="radio" name="promptMode" value="replace" checked={promptMode === 'replace'} onChange={() => setPromptMode('replace')} />
                <span>Replace the built-in prompt (advanced — the assistant loses Dockyard's built-in tool instructions)</span>
              </label>
            </div>
            <label className="settings-field">
              <span className="settings-field__label">Voice</span>
              <select className="input" value={voice} onChange={(e) => setVoice(e.target.value)}>
                <option value="alloy">alloy</option><option value="ash">ash</option>
                <option value="ballad">ballad</option><option value="coral">coral</option>
                <option value="echo">echo</option><option value="fable">fable</option>
                <option value="onyx">onyx</option><option value="nova">nova</option>
                <option value="sage">sage</option><option value="shimmer">shimmer</option>
                <option value="verse">verse</option>
              </select>
            </label>
            <label className="settings-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
              <span>Set as default assistant</span>
            </label>

            <div className="settings-field">
              <span className="settings-field__label">Tools ({toolList.length} selected)</span>
              <div className="tool-picker">
                {categories.map((cat) => {
                  const catTools = toolMeta.filter((t) => t.category === cat);
                  const catSelected = catTools.filter((t) => toolList.includes(t.name)).length;
                  return (
                    <details key={cat} className="tool-category">
                      <summary>
                        <input type="checkbox" checked={catTools.every((t) => toolList.includes(t.name) || alwaysIncluded.includes(t.name))}
                          onChange={(e) => { e.stopPropagation(); toggleCategory(catTools.map((t) => t.name)); }}
                          style={{ margin: 0 }} />
                        <span>{cat}</span>
                        <span className="muted" style={{ fontSize: 11 }}>({catSelected}/{catTools.length})</span>
                      </summary>
                      <div className="tool-category__list">
                        {catTools.map((t) => {
                          const isAlways = alwaysIncluded.includes(t.name);
                          return (
                            <label key={t.name} className="tool-chip" style={{ opacity: isAlways ? 0.6 : 1 }}>
                              <input type="checkbox" checked={toolList.includes(t.name) || isAlways} onChange={() => toggleTool(t.name)} disabled={isAlways} />
                              <span>{t.name}</span>
                              {t.readOnly && <span className="badge" style={{ marginLeft: 4, fontSize: 10, background: 'var(--bg-alt)' }}>read</span>}
                              {isAlways && <span className="badge" style={{ marginLeft: 4, fontSize: 10 }}>auto</span>}
                            </label>
                          );
                        })}
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
