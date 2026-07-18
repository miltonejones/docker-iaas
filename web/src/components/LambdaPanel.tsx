import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { oneDark } from "@codemirror/theme-one-dark";
import type {
  Container,
  LambdaFile,
  LambdaFunction,
  LambdaResult,
  LambdaRuntime,
} from "../types";
import { api } from "../api";
import { AssistantBar } from "./AssistantBar";
import { RuntimeIcon } from "../icons";
import { emitRefresh } from "../refresh";

const PLACEHOLDERS: Record<string, string> = {
  node: 'console.log("hello from Node.js");',
  python: 'print("hello from Python")',
  sh: 'echo "hello from shell" && uname -a',
};

const DEFAULT_ENTRY: Record<string, string> = {
  node: "index.js",
  python: "index.py",
  sh: "index.sh",
};

function editorLanguage(runtime: string, filePath: string) {
  if (runtime === "python") return python();
  if (runtime === "sh") return StreamLanguage.define(shell);
  return javascript({ typescript: /\.(?:[cm]?tsx?)$/i.test(filePath) });
}

export function LambdaPanel({
  functionId: initialFunctionId,
  onSaved,
  embedded,
}: {
  functionId?: string;
  onSaved?: (id: string) => void;
  embedded?: boolean;
}) {
  const [runtimes, setRuntimes] = useState<LambdaRuntime[]>([]);
  const [functions, setFunctions] = useState<LambdaFunction[]>([]);
  const [activeId, setActiveId] = useState<string | null>(
    initialFunctionId || null,
  );
  const [name, setName] = useState("");
  const [runtime, setRuntime] = useState("node");
  const [packages, setPackages] = useState("");
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<LambdaResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<LambdaResult[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [containers, setContainers] = useState<Container[]>([]);
  const [env, setEnv] = useState<{ key: string; value: string }[]>([]);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [savingEnv, setSavingEnv] = useState(false);
  const [envError, setEnvError] = useState<string | null>(null);
  const [showEnv, setShowEnv] = useState(false);

  // Multi-file editing: the entry point plus any number of additional
  // modules (barrel files, lib code, etc), all addressed by their real
  // relative path so imports/requires resolve like a normal project.
  // `filePaths` is the ordered tab list (entry point always first);
  // `contents` holds every file's text, keyed by path.
  const [entryPoint, setEntryPoint] = useState("index.js");
  const [filePaths, setFilePaths] = useState<string[]>(["index.js"]);
  const [contents, setContents] = useState<Record<string, string>>({
    "index.js": "",
  });
  const [activePath, setActivePath] = useState("index.js");
  const [newFileName, setNewFileName] = useState("");
  const [newPackageName, setNewPackageName] = useState("");
  const mainRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const [assistantHeight, setAssistantHeight] = useState<number>();

  const isSaved = activeId !== null;
  const code = contents[activePath] ?? "";
  const editorExtensions = useMemo(
    () => [editorLanguage(runtime, activePath)],
    [runtime, activePath],
  );

  // Load runtimes, saved functions, and running containers on mount.
  useEffect(() => {
    api.lambdaRuntimes().then(setRuntimes).catch(console.error);
    loadFunctions();
    api
      .containers()
      .then(setContainers)
      .catch(() => {});
  }, []);

  const loadFunctions = useCallback(async () => {
    try {
      const list = await api.lambdaListFunctions();
      setFunctions(list);
      return list;
    } catch {
      /* ignore */
    }
  }, []);

  // When embedded with a specific functionId, auto-select it once functions load.
  // When embedded without a functionId, start in new-function mode.
  useEffect(() => {
    if (!embedded) return;
    if (initialFunctionId) {
      api
        .lambdaListFunctions()
        .then((list) => {
          setFunctions(list);
          const fn = list.find((f) => f.id === initialFunctionId);
          if (fn) selectFunction(fn);
        })
        .catch(() => {});
    } else {
      newFunction();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFunctionId]);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await api.lambdaHistory());
    } catch {
      /* ignore */
    }
  }, []);

  // Reset to a single-file layout with a fresh placeholder when the runtime
  // changes and the editor is otherwise empty.
  useEffect(() => {
    if (!code.trim() && filePaths.length === 1) {
      const entry = DEFAULT_ENTRY[runtime] || "index.js";
      setEntryPoint(entry);
      setFilePaths([entry]);
      setContents({ [entry]: PLACEHOLDERS[runtime] || "" });
      setActivePath(entry);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime]);

  useLayoutEffect(() => {
    if (!embedded || !activeId || !mainRef.current || !editorRef.current) {
      setAssistantHeight(undefined);
      return;
    }

    const main = mainRef.current;
    const editor = editorRef.current;
    const updateHeight = () => {
      const height = Math.ceil(editor.getBoundingClientRect().bottom - main.getBoundingClientRect().top);
      setAssistantHeight((current) => (current === height ? current : height));
    };
    const observer = new ResizeObserver(updateHeight);
    observer.observe(main);
    observer.observe(editor);
    updateHeight();
    return () => observer.disconnect();
  }, [activeId, embedded]);

  function setCode(value: string) {
    setContents((prev) => ({ ...prev, [activePath]: value }));
  }

  function selectFunction(fn: LambdaFunction) {
    setActiveId(fn.id);
    setName(fn.name);
    setRuntime(fn.runtime);
    setPackages(fn.packages || "");
    const entry = fn.entryPoint || DEFAULT_ENTRY[fn.runtime] || "index.js";
    const extra = fn.files || [];
    setEntryPoint(entry);
    setFilePaths([entry, ...extra.map((f) => f.path)]);
    setContents({
      [entry]: fn.code,
      ...Object.fromEntries(extra.map((f) => [f.path, f.content])),
    });
    setActivePath(entry);
    setResult(null);
    setError(null);
    setRevealed(new Set());
    setEnvError(null);
    setShowEnv(false);
    api
      .lambdaGetEnv(fn.id)
      .then((e) =>
        setEnv(Object.entries(e).map(([key, value]) => ({ key, value }))),
      )
      .catch(() => setEnv([]));
  }

  function newFunction() {
    setActiveId(null);
    setName(`fn-${Math.random().toString(36).slice(2, 8)}`);
    setRuntime("node");
    setEntryPoint("index.js");
    setFilePaths(["index.js"]);
    setContents({ "index.js": PLACEHOLDERS.node });
    setActivePath("index.js");
    setPackages("");
    setResult(null);
    setError(null);
    setEnv([]);
    setRevealed(new Set());
    setEnvError(null);
    setShowEnv(false);
  }

  function addFile() {
    const path = newFileName.trim();
    if (!path || filePaths.includes(path)) return;
    setFilePaths((prev) => [...prev, path]);
    setContents((prev) => ({ ...prev, [path]: "" }));
    setActivePath(path);
    setNewFileName("");
  }

  function removeFile(path: string) {
    if (path === entryPoint) return; // entry point can't be removed
    setFilePaths((prev) => prev.filter((p) => p !== path));
    setContents((prev) => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
    if (activePath === path) setActivePath(entryPoint);
  }

  function addPackage() {
    const additions = newPackageName
      .split(/[\s,]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (additions.length === 0) return;
    const current = packages.trim().split(/\s+/).filter(Boolean);
    const merged = [...current];
    for (const pkg of additions) {
      if (!merged.includes(pkg)) merged.push(pkg);
    }
    setPackages(merged.join(" "));
    setNewPackageName("");
  }

  function removePackage(pkg: string) {
    const current = packages.trim().split(/\s+/).filter(Boolean);
    setPackages(current.filter((p) => p !== pkg).join(" "));
  }

  function addEnvRow() {
    setEnv((prev) => [...prev, { key: "", value: "" }]);
  }

  function updateEnvRow(i: number, field: "key" | "value", value: string) {
    setEnv((prev) =>
      prev.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)),
    );
  }

  function removeEnvRow(i: number) {
    setEnv((prev) => prev.filter((_, idx) => idx !== i));
  }

  function toggleReveal(i: number) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  async function saveEnv() {
    if (!activeId) return;
    setSavingEnv(true);
    setEnvError(null);
    try {
      const record = Object.fromEntries(
        env
          .filter((row) => row.key.trim())
          .map((row) => [row.key.trim(), row.value]),
      );
      await api.lambdaSetEnv(activeId, record);
    } catch (err) {
      setEnvError((err as Error).message);
    } finally {
      setSavingEnv(false);
    }
  }

  function extraFilesPayload(): LambdaFile[] {
    return filePaths
      .filter((p) => p !== entryPoint)
      .map((path) => ({ path, content: contents[path] ?? "" }));
  }

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const entryContent = contents[entryPoint] ?? "";
      if (isSaved) {
        const updated = await api.lambdaUpdateFunction(activeId!, {
          name: name.trim(),
          runtime,
          code: entryContent,
          packages: packages.trim(),
          entryPoint,
          files: extraFilesPayload(),
        });
        setFunctions((prev) =>
          prev.map((f) => (f.id === updated.id ? updated : f)),
        );
      } else {
        const created = await api.lambdaCreateFunction(
          name.trim(),
          runtime,
          entryContent,
          packages.trim(),
          entryPoint,
          extraFilesPayload(),
        );
        setActiveId(created.id);
        setFunctions((prev) => [created, ...prev]);
        onSaved?.(created.id);
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
      const entryContent = contents[entryPoint] ?? "";
      const res = await api.lambdaRun(
        runtime,
        entryContent,
        packages.trim() || undefined,
        activeId ?? undefined,
        extraFilesPayload(),
        entryPoint,
      );
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
    const historyEntry = DEFAULT_ENTRY[entry.runtime] || "index.js";
    setEntryPoint(historyEntry);
    setFilePaths([historyEntry]);
    setContents({
      [historyEntry]:
        entry.stdout ||
        entry.stderr ||
        (entry.error ? `// error: ${entry.error}` : ""),
    });
    setActivePath(historyEntry);
    setResult(entry);
    setShowHistory(false);
  }

  const currentRuntime = runtimes.find((r) => r.id === runtime);
  const functionAssistantContext = activeId
    ? `You are the dedicated assistant for the function currently open in Dockyard's editor. Help only with this function unless the user explicitly asks otherwise. Its id is "${activeId}". Do not create, delete, run, or modify any other resource unless the user explicitly asks.

For any source-file change, including adding or removing a file, call replace_lambda_function_files exactly once. Its files argument must contain the COMPLETE desired file set, including the entry point and every existing file to keep, with complete content for each. The current editor state below is authoritative. Do not describe a future retry or apologize: formulate the complete updated files array and call the tool.

Current editor state:
${JSON.stringify(
  {
    id: activeId,
    name,
    runtime,
    packages,
    entryPoint,
    files: filePaths.map((path) => ({ path, content: contents[path] ?? "" })),
  },
  null,
  2,
)}`
    : undefined;

  async function refreshFunctionAfterAssistantChange() {
    emitRefresh();
    if (!activeId) return;
    try {
      selectFunction(await api.lambdaGetFunction(activeId));
    } catch {
      await loadFunctions();
    }
  }

  return (
    <section className="panel">
      {!embedded && (
        <div className="panel__head">
          <h2>
            Lambda <span className="count">fn</span>
          </h2>
          <button className="btn btn--primary btn--sm" onClick={newFunction}>
            + New function
          </button>
        </div>
      )}

      <div className={`panel-layout${embedded ? activeId && functionAssistantContext ? " panel-layout--with-assistant" : " panel-layout--full" : ""}`}>
        {/* Sidebar — function list (hidden in embedded/detail mode) */}
        {!embedded && (
          <aside className="panel-sidebar">
            <button
              className="btn btn--primary panel-new-btn"
              onClick={newFunction}
            >
              + New function
            </button>
            <div className="panel-item-list">
              {functions.length === 0 ? (
                <p className="muted empty-sm">No saved functions yet.</p>
              ) : (
                functions.map((fn) => (
                  <button
                    key={fn.id}
                    className={`panel-item${fn.id === activeId ? " panel-item--active" : ""}`}
                    onClick={() => selectFunction(fn)}
                  >
                    <span className="panel-item-name">{fn.name}</span>
                    <span
                      className="chip"
                      style={{ fontSize: "10px", padding: "1px 7px" }}
                    >
                      {fn.runtime}
                    </span>
                  </button>
                ))
              )}
            </div>

            {/* Running containers — available as hostnames */}
            <div className="lambda-containers">
              <h4 className="detail-subtitle" style={{ marginTop: 0 }}>
                Running containers
              </h4>
              {containers.filter((c) => c.state === "running").length === 0 ? (
                <p className="muted empty-sm">No running containers.</p>
              ) : (
                <div className="lambda-container-list">
                  {containers
                    .filter((c) => c.state === "running")
                    .map((c) => (
                      <div className="lambda-container-item" key={c.id}>
                        <span
                          className="mono"
                          style={{
                            fontSize: "11px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {c.name || c.id.slice(0, 12)}
                        </span>
                        <span className="muted" style={{ fontSize: "10px" }}>
                          {c.ports
                            .filter((p) => p.publicPort)
                            .map((p) => `:${p.publicPort}`)
                            .join(", ") || "—"}
                        </span>
                      </div>
                    ))}
                </div>
              )}
              <p
                className="muted"
                style={{ fontSize: "10px", marginTop: "6px", lineHeight: 1.4 }}
              >
                Use the container name as the hostname in your function code.
                All containers share the <code>dockyard-net</code> network.
              </p>
            </div>
          </aside>
        )}

        {/* Main — editor + output */}
        <div className="panel-main" ref={mainRef}>
          {/* Name + runtime + dependencies — single row */}
          <div className="lambda-meta">
            {isSaved ? (
              <span className="lambda-name-static">{name}</span>
            ) : (
              <input
                className="lambda-name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Function name"
                spellCheck={false}
              />
            )}
            {!isSaved && (
              <div className="chips">
                {runtimes.map((r) => (
                  <button
                    key={r.id}
                    className={`chip ${runtime === r.id ? "chip--on" : ""}`}
                    onClick={() => setRuntime(r.id)}
                  >
                    <RuntimeIcon id={r.id} /> {r.name}
                  </button>
                ))}
              </div>
            )}
            <div className="lambda-package-pills">
              {packages
                .trim()
                .split(/\s+/)
                .filter(Boolean)
                .map((pkg) => (
                  <span className="lambda-package-pill" key={pkg}>
                    <span className="mono">{pkg}</span>
                    <span
                      className="lambda-package-pill__close"
                      onClick={() => removePackage(pkg)}
                      title={`Remove ${pkg}`}
                    >
                      ×
                    </span>
                  </span>
                ))}
              <input
                className="lambda-package-pill-add"
                value={newPackageName}
                onChange={(e) => setNewPackageName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addPackage();
                  }
                }}
                placeholder={
                  runtime === "node"
                    ? "+ mysql2, axios…"
                    : runtime === "python"
                      ? "+ requests, flask…"
                      : "+ curl, jq…"
                }
                spellCheck={false}
              />
            </div>
          </div>

          {/* File tabs — entry point plus any additional modules */}
          <div className="lambda-file-tabs">
            {filePaths.map((path) => (
              <button
                key={path}
                className={`lambda-file-tab${path === activePath ? " lambda-file-tab--active" : ""}`}
                onClick={() => setActivePath(path)}
                title={path === entryPoint ? `${path} (entry point)` : path}
              >
                <span className="mono">{path}</span>
                {path === entryPoint ? (
                  <span className="lambda-file-tab__badge">entry</span>
                ) : (
                  <span
                    className="lambda-file-tab__close"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFile(path);
                    }}
                  >
                    ×
                  </span>
                )}
              </button>
            ))}
            <input
              className="lambda-file-tab-add"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addFile();
              }}
              placeholder="+ lib/util.js"
              spellCheck={false}
            />
          </div>

          {/* Editor */}
          <div
            className={
              embedded && activeId ? "lambda-editor-with-assistant" : undefined
            }
          >
            <div className="lambda-editor-wrap" ref={editorRef}>
              <CodeMirror
                className="lambda-editor"
                value={code}
                height="520px"
                theme={oneDark}
                extensions={editorExtensions}
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: true,
                  highlightActiveLine: true,
                  highlightActiveLineGutter: true,
                  bracketMatching: true,
                  closeBrackets: true,
                  indentOnInput: true,
                }}
                onChange={setCode}
              />

              <div className="lambda-editor-foot">
                <span className="muted mono" style={{ fontSize: "11px" }}>
                  {currentRuntime?.image ?? runtime}
                </span>
                <div style={{ display: "flex", gap: "8px" }}>
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
                    onClick={() => setShowEnv(true)}
                    title={
                      isSaved
                        ? "Environment variables"
                        : "Save the function first to add environment variables"
                    }
                  >
                    Env{env.length > 0 ? ` (${env.length})` : ""}
                  </button>
                  <button
                    className="btn btn--sm"
                    onClick={() => {
                      setShowHistory(!showHistory);
                      if (!showHistory) loadHistory();
                    }}
                  >
                    {showHistory ? "Hide history" : "History"}
                  </button>
                  <button
                    className="btn btn--sm"
                    disabled={saving || !name.trim()}
                    onClick={save}
                  >
                    {saving ? "Saving…" : isSaved ? "Update" : "Save"}
                  </button>
                  <button
                    className="btn btn--primary"
                    disabled={running || !(contents[entryPoint] || "").trim()}
                    onClick={run}
                  >
                    {running ? "Running…" : "Run"}
                  </button>
                </div>
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
                      Exit {result.exitCode} · {result.durationMs}ms ·{" "}
                      {new Date(result.timestamp).toLocaleTimeString()}
                    </>
                  ) : (
                    "Error"
                  )}
                </span>
              </div>
              {error && (
                <pre className="logs lambda-output__pre lambda-output__err">
                  {error}
                </pre>
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
        {embedded && activeId && functionAssistantContext && (
          <aside className="function-assistant" style={assistantHeight ? { height: assistantHeight } : undefined}>
            <AssistantBar
              key={activeId}
              embedded
              contextPrompt={functionAssistantContext}
              onChanged={refreshFunctionAfterAssistantChange}
              sessionStorageKey={`dockyard:function-assistant:${activeId}`}
            />
          </aside>
        )}
      </div>

      {/* Environment variables modal — stored separately from code, masked by default. */}
      {showEnv && (
        <div className="modal-backdrop" onClick={() => setShowEnv(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head">
              <h3>Environment variables</h3>
              <button
                className="btn btn--ghost"
                onClick={() => setShowEnv(false)}
              >
                Close
              </button>
            </div>
            {isSaved ? (
              <>
                {env.length === 0 && (
                  <p className="muted empty-sm">
                    No environment variables set.
                  </p>
                )}
                {env.map((row, i) => (
                  <div className="env-row" key={i}>
                    <input
                      value={row.key}
                      placeholder="KEY"
                      spellCheck={false}
                      onChange={(e) => updateEnvRow(i, "key", e.target.value)}
                    />
                    <input
                      type={revealed.has(i) ? "text" : "password"}
                      value={row.value}
                      placeholder="value"
                      spellCheck={false}
                      onChange={(e) => updateEnvRow(i, "value", e.target.value)}
                    />
                    <button
                      className="btn btn--sm btn--ghost"
                      onClick={() => toggleReveal(i)}
                    >
                      {revealed.has(i) ? "Hide" : "Show"}
                    </button>
                    <button
                      className="btn btn--sm btn--danger"
                      onClick={() => removeEnvRow(i)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                  <button className="btn btn--sm" onClick={addEnvRow}>
                    + Add variable
                  </button>
                  <button
                    className="btn btn--sm btn--primary"
                    disabled={savingEnv}
                    onClick={saveEnv}
                  >
                    {savingEnv ? "Saving…" : "Save variables"}
                  </button>
                </div>
                {envError && <p className="muted empty-sm">{envError}</p>}
              </>
            ) : (
              <p className="muted empty-sm">
                Save the function first to add environment variables.
              </p>
            )}
          </div>
        </div>
      )}

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
                    style={{ fontSize: "10px", padding: "2px 8px" }}
                  >
                    {entry.runtime}
                  </span>
                  <span
                    className="mono muted"
                    style={{
                      fontSize: "11px",
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {(entry.stdout || entry.stderr || entry.error || "").slice(
                      0,
                      80,
                    )}
                  </span>
                  <span
                    className="muted"
                    style={{ fontSize: "10px", whiteSpace: "nowrap" }}
                  >
                    {entry.durationMs}ms ·{" "}
                    {entry.exitCode === 0 ? "OK" : `exit ${entry.exitCode}`}
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
