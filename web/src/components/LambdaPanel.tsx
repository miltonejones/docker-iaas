import { useCallback, useEffect, useState } from 'react';
import type { Container, LambdaFunction, LambdaResult, LambdaRuntime } from '../types';
import { api } from '../api';

const PLACEHOLDERS: Record<string, string> = {
  node: 'console.log("hello from Node.js");',
  python: 'print("hello from Python")',
  sh: 'echo "hello from shell" && uname -a',
};

export function LambdaPanel() {
  const [runtimes, setRuntimes] = useState<LambdaRuntime[]>([]);
  const [functions, setFunctions] = useState<LambdaFunction[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [runtime, setRuntime] = useState('node');
  const [code, setCode] = useState('');
  const [packages, setPackages] = useState('');
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<LambdaResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<LambdaResult[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [containers, setContainers] = useState<Container[]>([]);

  const isSaved = activeId !== null;

  // Load runtimes, saved functions, and running containers on mount.
  useEffect(() => {
    api.lambdaRuntimes().then(setRuntimes).catch(console.error);
    loadFunctions();
    api.containers().then(setContainers).catch(() => {});
  }, []);

  const loadFunctions = useCallback(async () => {
    try {
      setFunctions(await api.lambdaListFunctions());
    } catch {
      /* ignore */
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await api.lambdaHistory());
    } catch {
      /* ignore */
    }
  }, []);

  // Set placeholder when runtime changes (only if editor is empty).
  useEffect(() => {
    if (!code.trim()) {
      setCode(PLACEHOLDERS[runtime] || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime]);

  function selectFunction(fn: LambdaFunction) {
    setActiveId(fn.id);
    setName(fn.name);
    setRuntime(fn.runtime);
    setCode(fn.code);
    setPackages(fn.packages || '');
    setResult(null);
    setError(null);
  }

  function newFunction() {
    setActiveId(null);
    setName(`fn-${Math.random().toString(36).slice(2, 8)}`);
    setRuntime('node');
    setCode(PLACEHOLDERS.node);
    setPackages('');
    setResult(null);
    setError(null);
  }

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (isSaved) {
        const updated = await api.lambdaUpdateFunction(activeId!, {
          name: name.trim(),
          runtime,
          code,
          packages: packages.trim(),
        });
        setFunctions((prev) =>
          prev.map((f) => (f.id === updated.id ? updated : f)),
        );
      } else {
        const created = await api.lambdaCreateFunction(
          name.trim(),
          runtime,
          code,
          packages.trim(),
        );
        setActiveId(created.id);
        setFunctions((prev) => [created, ...prev]);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function deleteActive() {
    if (!isSaved) return;
    const fn = functions.find((f) => f.id === activeId);
    if (!confirm(`Delete "${fn?.name || activeId}"?`)) return;
    try {
      await api.lambdaDeleteFunction(activeId!);
      setFunctions((prev) => prev.filter((f) => f.id !== activeId));
      newFunction();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.lambdaRun(runtime, code, packages.trim() || undefined);
      setResult(res);
      loadHistory();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  function selectHistory(entry: LambdaResult) {
    setRuntime(entry.runtime);
    setCode(
      entry.stdout ||
        entry.stderr ||
        (entry.error ? `// error: ${entry.error}` : ''),
    );
    setResult(entry);
    setShowHistory(false);
  }

  const currentRuntime = runtimes.find((r) => r.id === runtime);

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>
          Lambda <span className="count">fn</span>
        </h2>
      </div>

      <div className="lambda-layout">
        {/* Sidebar — function list */}
        <aside className="lambda-sidebar">
          <button className="btn btn--primary lambda-new-btn" onClick={newFunction}>
            + New function
          </button>
          <div className="lambda-fn-list">
            {functions.length === 0 ? (
              <p className="muted empty-sm">No saved functions yet.</p>
            ) : (
              functions.map((fn) => (
                <button
                  key={fn.id}
                  className={`lambda-fn-item${fn.id === activeId ? ' lambda-fn-item--active' : ''}`}
                  onClick={() => selectFunction(fn)}
                >
                  <span className="lambda-fn-name">{fn.name}</span>
                  <span className="chip" style={{ fontSize: '10px', padding: '1px 7px' }}>
                    {fn.runtime}
                  </span>
                </button>
              ))
            )}
          </div>

          {/* Running containers — available as hostnames */}
          <div className="lambda-containers">
            <h4 className="detail-subtitle" style={{ marginTop: 0 }}>Running containers</h4>
            {containers.filter((c) => c.state === 'running').length === 0 ? (
              <p className="muted empty-sm">No running containers.</p>
            ) : (
              <div className="lambda-container-list">
                {containers
                  .filter((c) => c.state === 'running')
                  .map((c) => (
                    <div className="lambda-container-item" key={c.id}>
                      <span className="mono" style={{ fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.name || c.id.slice(0, 12)}
                      </span>
                      <span className="muted" style={{ fontSize: '10px' }}>
                        {c.ports
                          .filter((p) => p.publicPort)
                          .map((p) => `:${p.publicPort}`)
                          .join(', ') || '—'}
                      </span>
                    </div>
                  ))}
              </div>
            )}
            <p className="muted" style={{ fontSize: '10px', marginTop: '6px', lineHeight: 1.4 }}>
              Use the container name as the hostname in your function code. All containers share the <code>dockyard-net</code> network.
            </p>
          </div>
        </aside>

        {/* Main — editor + output */}
        <div className="lambda-main">
          {/* Name + runtime */}
          <div className="lambda-meta">
            <input
              className="lambda-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Function name"
              spellCheck={false}
            />
            <div className="chips">
              {runtimes.map((r) => (
                <button
                  key={r.id}
                  className={`chip ${runtime === r.id ? 'chip--on' : ''}`}
                  onClick={() => setRuntime(r.id)}
                >
                  {r.icon} {r.name}
                </button>
              ))}
            </div>
          </div>

          <input
            className="lambda-packages-input"
            value={packages}
            onChange={(e) => setPackages(e.target.value)}
            placeholder={
              runtime === 'node'
                ? 'mysql2 axios lodash'
                : runtime === 'python'
                  ? 'requests flask sqlalchemy'
                  : 'curl jq git'
            }
            spellCheck={false}
          />

          {/* Editor */}
          <div className="lambda-editor-wrap">
            <textarea
              className="lambda-editor"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              spellCheck={false}
              placeholder={PLACEHOLDERS[runtime] || ''}
              rows={10}
            />
            <div className="lambda-editor-foot">
              <span className="muted mono" style={{ fontSize: '11px' }}>
                {currentRuntime?.image ?? runtime}
              </span>
              <div style={{ display: 'flex', gap: '8px' }}>
                {isSaved && (
                  <button
                    className="btn btn--sm btn--danger"
                    onClick={deleteActive}
                  >
                    Delete
                  </button>
                )}
                <button
                  className="btn btn--sm"
                  onClick={() => {
                    setShowHistory(!showHistory);
                    if (!showHistory) loadHistory();
                  }}
                >
                  {showHistory ? 'Hide history' : 'History'}
                </button>
                <button
                  className="btn btn--sm"
                  disabled={saving || !name.trim()}
                  onClick={save}
                >
                  {saving ? 'Saving…' : isSaved ? 'Update' : 'Save'}
                </button>
                <button
                  className="btn btn--primary"
                  disabled={running || !code.trim()}
                  onClick={run}
                >
                  {running ? 'Running…' : 'Run'}
                </button>
              </div>
            </div>
          </div>

          {/* Output */}
          {(result || error) && (
            <div className="lambda-output">
              <div className="lambda-output__head">
                <span className="muted">
                  {result ? (
                    <>
                      Exit {result.exitCode} · {result.durationMs}ms ·{' '}
                      {new Date(result.timestamp).toLocaleTimeString()}
                    </>
                  ) : (
                    'Error'
                  )}
                </span>
              </div>
              {error && (
                <pre className="logs lambda-output__pre lambda-output__err">{error}</pre>
              )}
              {result && result.stdout && (
                <pre className="logs lambda-output__pre">{result.stdout}</pre>
              )}
              {result && result.stderr && (
                <pre className="logs lambda-output__pre lambda-output__err">
                  {result.stderr}
                </pre>
              )}
              {result && !result.stdout && !result.stderr && !error && (
                <p className="muted empty-sm">(no output)</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* History */}
      {showHistory && (
        <div className="lambda-history">
          <h4 className="detail-subtitle">Recent runs</h4>
          {history.length === 0 ? (
            <p className="muted empty-sm">No runs yet.</p>
          ) : (
            <div className="lambda-history-list">
              {history.map((entry, i) => (
                <button
                  key={i}
                  className="lambda-history-item"
                  onClick={() => selectHistory(entry)}
                >
                  <span
                    className="chip chip--on"
                    style={{ fontSize: '10px', padding: '2px 8px' }}
                  >
                    {entry.runtime}
                  </span>
                  <span
                    className="mono muted"
                    style={{
                      fontSize: '11px',
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {(entry.stdout || entry.stderr || entry.error || '').slice(0, 80)}
                  </span>
                  <span className="muted" style={{ fontSize: '10px', whiteSpace: 'nowrap' }}>
                    {entry.durationMs}ms ·{' '}
                    {entry.exitCode === 0 ? 'OK' : `exit ${entry.exitCode}`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
