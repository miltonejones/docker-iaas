import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { timeAgo } from '../format';
import type {
  AssistantLogEntry,
  AssistantPendingAction,
  AssistantResolvedResult,
  AssistantSessionState,
  AssistantSessionSummary,
  AssistantTurn,
} from '../types';

type LogEntry = AssistantLogEntry;
type ResolvedResult = AssistantResolvedResult;

const ACTION_LABEL: Record<string, string> = {
  create_lambda_function: 'Create Lambda function',
  create_gateway_route: 'Create Gateway route',
  update_lambda_function: 'Update Lambda function',
  delete_lambda_function: 'Delete Lambda function',
  delete_gateway_route: 'Delete Gateway route',
  launch_container: 'Launch container',
  container_action: 'Container action',
  write_container_file: 'Write container file',
  delete_container: 'Delete container',
  delete_image: 'Delete image',
  prune_images: 'Prune unused images',
  create_bucket: 'Create bucket',
  delete_bucket: 'Delete bucket',
  delete_bucket_object: 'Delete bucket object',
  write_bucket_object: 'Write bucket file',
  prune_build_cache: 'Prune build cache',
  run_function: 'Run function',
};

const LOOKUP_LABEL: Record<string, string> = {
  list_containers: 'containers',
  list_functions: 'functions',
  list_gateway_routes: 'gateway routes',
  list_buckets: 'buckets',
  list_images: 'images',
  list_bucket_objects: 'bucket contents',
  read_bucket_object: 'file content',
};

/** Actions that mutate/destroy state in a way worth calling out visually,
 *  beyond the ordinary Confirm/Cancel gate every action already goes through. */
const DESTRUCTIVE = new Set([
  'delete_lambda_function',
  'delete_gateway_route',
  'delete_container',
  'delete_image',
  'delete_bucket',
  'delete_bucket_object',
  'prune_images',
  'prune_build_cache',
]);

/** autoResolved entries only carry a toolUseId — look the tool's name back
 *  up from the tool_use block that requested it, so we can show a friendly
 *  "Looked up: containers" line instead of nothing at all. */
function findToolName(messages: unknown[], toolUseId: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown };
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const block = (msg.content as { type?: string; id?: string; name?: string }[]).find(
      (b) => b?.type === 'tool_use' && b.id === toolUseId,
    );
    if (block?.name) return block.name;
  }
  return undefined;
}

/** Default a session's name from its first user prompt when nobody typed
 *  one explicitly. */
function deriveSessionName(log: LogEntry[]): string {
  const firstUser = log.find((e) => e.kind === 'user')?.text.trim();
  if (!firstUser) return 'Untitled session';
  return firstUser.length > 60 ? `${firstUser.slice(0, 60)}…` : firstUser;
}

interface Props {
  onClose: () => void;
  /** Called after any create so pages showing that data can refresh next time they mount. */
  onChanged?: () => void;
  /** A prompt already submitted from the toolbar search box — run it
   *  immediately on mount instead of waiting for the user to type it again. */
  initialPrompt?: string;
  /** If set, load this saved session on mount instead of running a new
   *  prompt. Takes precedence over `initialPrompt`. */
  initialSessionId?: string;
}

export function AssistantBar({ onClose, onChanged, initialPrompt, initialSessionId }: Props) {
  const [prompt, setPrompt] = useState('');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [rawMessages, setRawMessages] = useState<unknown[]>([]);
  const [pending, setPending] = useState<AssistantPendingAction[]>([]);
  const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>({});
  const [resolved, setResolved] = useState<ResolvedResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Auto-scroll the conversation to the bottom as new text streams in, but
  // only when the reader is already near the bottom — so scrolling up to reread
  // earlier output isn't hijacked by each incoming token.
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [log, error, pending]);
  // Guards the initial-prompt effect below against React StrictMode's
  // dev-only double-invoke of effects (mount → cleanup → mount) — without
  // this, the same prompt gets submitted twice and comes back with two
  // separate answers. The ref survives that double-invoke since only the
  // effect (not the component instance) is torn down and rerun.
  const firedInitialPrompt = useRef(false);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState('');
  const [sessionSaving, setSessionSaving] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessionsList, setSessionsList] = useState<AssistantSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  // Autosave: whenever the conversation actually changes, persist it —
  // creating the session on first save (named from the first prompt unless
  // the user already typed one) and updating it on every turn after that.
  // Skipped while a turn is in flight (busy) and on the pristine empty
  // render, so we don't create a session for a modal nobody used yet.
  useEffect(() => {
    if (busy) return;
    if (log.length === 0 && rawMessages.length === 0) return;

    let cancelled = false;
    async function persist() {
      setSessionSaving(true);
      const state: AssistantSessionState = { messages: rawMessages, log, pending, resolved };
      try {
        if (!sessionId) {
          const custom = sessionName.trim();
          const name = custom || deriveSessionName(log);
          const created = await api.assistantCreateSession(name, state);
          if (cancelled) return;
          setSessionId(created.id);
          setSessionName(created.name);
          // If the user didn't name it themselves, ask Claude for a friendly
          // title and rename the session once. Best-effort and non-blocking —
          // saving already completed with the placeholder name, so a failure
          // here just leaves the truncated-first-message heuristic in place.
          if (!custom) {
            const firstUser = log.find((e) => e.kind === 'user')?.text ?? '';
            const lastAssistant = [...log].reverse().find((e) => e.kind === 'assistant')?.text ?? '';
            api
              .assistantGenerateTitle(firstUser, lastAssistant)
              .then(({ name: title }) => {
                if (cancelled || !title) return;
                setSessionName(title);
                return api.assistantUpdateSession(created.id, { name: title });
              })
              .catch(() => {
                /* best-effort: keep the placeholder name */
              });
          }
        } else {
          await api.assistantUpdateSession(sessionId, { state });
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setSessionSaving(false);
      }
    }
    void persist();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawMessages, log, pending, resolved, busy]);

  function resetToNewSession() {
    setSessionId(null);
    setSessionName('');
    setPrompt('');
    setLog([]);
    setRawMessages([]);
    setPending([]);
    setEdits({});
    setResolved([]);
    setError(null);
    setSessionsOpen(false);
  }

  async function loadSession(id: string) {
    setError(null);
    try {
      const session = await api.assistantGetSession(id);
      setSessionId(session.id);
      setSessionName(session.name);
      setLog(session.state.log ?? []);
      setRawMessages(session.state.messages ?? []);
      setPending(session.state.pending ?? []);
      setEdits(Object.fromEntries((session.state.pending ?? []).map((p) => [p.id, { ...p.input }])));
      setResolved(session.state.resolved ?? []);
      setSessionsOpen(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function toggleSessionsList() {
    if (sessionsOpen) {
      setSessionsOpen(false);
      return;
    }
    setSessionsOpen(true);
    setSessionsLoading(true);
    try {
      setSessionsList(await api.assistantListSessions());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSessionsLoading(false);
    }
  }

  // Typing just updates local state; the rename is only sent to the server
  // on blur/Enter (commitSessionName) so we're not firing a PUT per keystroke.
  async function commitSessionName() {
    const trimmed = sessionName.trim();
    if (!sessionId || !trimmed) return;
    try {
      await api.assistantUpdateSession(sessionId, { name: trimmed });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function deleteSessionRow(id: string) {
    try {
      await api.assistantDeleteSession(id);
      setSessionsList((list) => list.filter((s) => s.id !== id));
      if (id === sessionId) resetToNewSession();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /** Update rawMessages, pending, edits, and resolved from a turn — without
   *  touching the log (so the streaming path can manage the log itself). */
  function applyTurnState(turn: AssistantTurn) {
    setRawMessages(turn.messages);
    setPending(turn.pending);
    setEdits(Object.fromEntries(turn.pending.map((p) => [p.id, { ...p.input }])));
    setResolved(turn.autoResolved ?? []);
  }

  /** Consume an SSE stream from the assistant, updating the log with
   *  streaming text in real-time and applying the turn state when it
   *  arrives. The caller must have already set busy=true and added the
   *  user prompt to the log. */
  async function consumeTurnStream(stream: AsyncGenerator<Record<string, unknown>>) {
    let streamedText = '';
    setLog((l) => [...l, { kind: 'assistant', text: '' }]);

    for await (const event of stream) {
      if (event.type === 'text') {
        streamedText += event.delta as string;
        setLog((l) => {
          const copy = [...l];
          copy[copy.length - 1] = { kind: 'assistant', text: streamedText };
          return copy;
        });
      } else if (event.type === 'turn') {
        const turn = event as unknown as AssistantTurn;
        // Replace the streaming placeholder with the final text.
        setLog((l) => {
          const copy = [...l];
          copy[copy.length - 1] = { kind: 'assistant', text: streamedText || turn.text };
          return copy;
        });
        applyTurnState(turn);
        if (turn.autoResolved?.length) {
          const labels = Array.from(
            new Set(
              turn.autoResolved.map((r) => {
                const name = findToolName(turn.messages, r.toolUseId);
                return (name && LOOKUP_LABEL[name]) || name || 'resource';
              }),
            ),
          );
          setLog((l) => [...l, { kind: 'action', text: `Looked up: ${labels.join(', ')}` }]);
        }
        return;
      } else if (event.type === 'error') {
        setError(event.message as string);
        return;
      }
    }
  }

  async function askWithText(text: string) {
    setBusy(true);
    setError(null);
    setLog((l) => [...l, { kind: 'user', text }]);
    setPrompt('');
    try {
      const stream = await api.assistantPlanStream(text, rawMessages);
      await consumeTurnStream(stream);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function ask() {
    const text = prompt.trim();
    if (!text || busy) return;
    await askWithText(text);
  }

  // Load a saved session on mount when opened from the offcanvas panel.
  // Takes precedence over initialPrompt — if both are set, the session wins.
  useEffect(() => {
    if (!initialSessionId) return;
    let cancelled = false;
    async function load() {
      setBusy(true);
      try {
        const session = await api.assistantGetSession(initialSessionId!);
        if (cancelled) return;
        setSessionId(session.id);
        setSessionName(session.name);
        setLog(session.state.log ?? []);
        setRawMessages(session.state.messages ?? []);
        setPending(session.state.pending ?? []);
        setEdits(
          Object.fromEntries(
            (session.state.pending ?? []).map((p) => [p.id, { ...p.input }]),
          ),
        );
        setResolved(session.state.resolved ?? []);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Run a prompt that arrived pre-submitted from the toolbar search box —
  // once per mount, i.e. once per time this modal is opened. Skipped when
  // a session was loaded instead.
  useEffect(() => {
    if (firedInitialPrompt.current) return;
    firedInitialPrompt.current = true;
    if (initialSessionId) return; // session already loaded above
    const text = initialPrompt?.trim();
    if (text) void askWithText(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runAction(action: AssistantPendingAction, input: Record<string, unknown>): Promise<unknown> {
    const str = (v: unknown) => (v == null || v === '' ? undefined : String(v));
    const bool = (v: unknown) => v === true || v === 'true';

    switch (action.name) {
      case 'create_lambda_function':
        return api.lambdaCreateFunction(
          String(input.name ?? ''),
          String(input.runtime ?? 'node'),
          String(input.code ?? ''),
          str(input.packages),
          str(input.entryPoint),
        );

      case 'update_lambda_function':
        return api.lambdaUpdateFunction(String(input.id ?? ''), {
          name: str(input.name),
          runtime: str(input.runtime),
          code: str(input.code),
          packages: str(input.packages),
          entryPoint: str(input.entryPoint),
        });

      case 'delete_lambda_function':
        return api.lambdaDeleteFunction(String(input.id ?? ''));

      case 'create_gateway_route':
        return api.gatewayCreate({
          name: String(input.name ?? ''),
          targetType: String(input.targetType ?? ''),
          targetId: String(input.targetId ?? ''),
          targetPort: input.targetPort != null && input.targetPort !== '' ? Number(input.targetPort) : undefined,
          method: str(input.method),
          pathPattern: str(input.pathPattern),
        });

      case 'delete_gateway_route':
        return api.gatewayDelete(String(input.id ?? ''));

      case 'launch_container':
        return api.launch({
          presetId: str(input.presetId),
          image: str(input.image),
          name: str(input.name),
          ports: Array.isArray(input.ports) ? (input.ports as { container: string; host: number }[]) : undefined,
          env: Array.isArray(input.env) ? (input.env as { key: string; value: string }[]) : undefined,
          autoStart: true,
        });

      case 'container_action':
        return api.action(String(input.id ?? ''), input.action as 'start' | 'stop' | 'restart');

      case 'write_container_file':
        return api.containerWriteFile(
          String(input.id ?? ''),
          String(input.path ?? ''),
          String(input.content ?? ''),
        );

      case 'delete_container':
        return api.remove(String(input.id ?? ''), bool(input.force));

      case 'delete_image':
        return api.removeImage(String(input.id ?? ''), bool(input.force));

      case 'prune_images':
        return api.prune();

      case 'create_bucket':
        return api.bucketCreate(String(input.name ?? ''));

      case 'delete_bucket':
        return api.bucketDelete(String(input.name ?? ''));

      case 'delete_bucket_object':
        return api.bucketDeleteObject(String(input.name ?? ''), String(input.key ?? ''));

      case 'write_bucket_object':
        return api.bucketWriteObject(
          String(input.name ?? ''),
          String(input.key ?? ''),
          String(input.content ?? ''),
          str(input.contentType) ?? 'text/plain',
        );

      case 'prune_build_cache':
        return api.pruneBuildCache();

      case 'run_function': {
        // The /run endpoint needs the function's actual code/runtime/entry
        // (functionId alone only injects env vars), so load the saved function
        // first, then run it with that id so its env vars apply too.
        const fn = await api.lambdaGetFunction(String(input.id ?? ''));
        return api.lambdaRun(
          fn.runtime,
          fn.code,
          fn.packages || undefined,
          fn.id,
          fn.files,
          fn.entryPoint,
          input.payload,
        );
      }

      default:
        throw new Error(`Unknown action "${action.name}".`);
    }
  }

  async function decide(action: AssistantPendingAction, approved: boolean) {
    setBusy(true);
    setError(null);

    let entry: ResolvedResult;
    if (!approved) {
      setLog((l) => [...l, { kind: 'action', text: `Skipped: ${ACTION_LABEL[action.name] ?? action.name}` }]);
      entry = { toolUseId: action.id, ok: false, content: 'The user declined this action.' };
    } else {
      try {
        const result = await runAction(action, edits[action.id] ?? action.input);
        setLog((l) => [...l, { kind: 'action', text: `Done: ${ACTION_LABEL[action.name] ?? action.name}` }]);
        onChanged?.();
        entry = { toolUseId: action.id, ok: true, content: result };
      } catch (err) {
        setLog((l) => [...l, { kind: 'error', text: (err as Error).message }]);
        entry = { toolUseId: action.id, ok: false, content: { error: (err as Error).message } };
      }
    }

    const nextResolved = [...resolved, entry];
    const remaining = pending.filter((p) => !nextResolved.some((r) => r.toolUseId === p.id));
    if (remaining.length > 0) {
      // More tool calls in this turn are still awaiting a decision — hold
      // off calling the model again until every one of them has an answer,
      // since Claude expects all tool_result blocks for a turn at once.
      setResolved(nextResolved);
      setPending(remaining);
      setBusy(false);
      return;
    }

    try {
      const stream = await api.assistantConfirmStream(rawMessages, nextResolved);
      await consumeTurnStream(stream);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function editField(actionId: string, key: string, value: unknown) {
    setEdits((s) => ({ ...s, [actionId]: { ...s[actionId], [key]: value } }));
  }

  /** Object/array fields (e.g. launch_container's ports/env) are edited as
   *  pretty-printed JSON; keep the parsed value while it's valid, otherwise
   *  hold the raw text so typing isn't blocked mid-edit. */
  function editJsonField(actionId: string, key: string, text: string) {
    try {
      editField(actionId, key, JSON.parse(text));
    } catch {
      editField(actionId, key, text);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--assistant" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h3>✨ Ask Dockyard.ai</h3>
          <button className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="assistant-session-bar">
          <input
            className="assistant-session-bar__name"
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            onBlur={commitSessionName}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            placeholder="Untitled session"
          />
          {sessionSaving && <span className="assistant-session-bar__status muted">Saving…</span>}
          <div className="assistant-session-bar__actions">
            <button className="btn btn--ghost btn--sm" onClick={resetToNewSession}>
              + New
            </button>
            <button className="btn btn--ghost btn--sm" onClick={toggleSessionsList}>
              📂 Sessions
            </button>
          </div>
        </div>

        {sessionsOpen && (
          <div className="assistant-sessions-panel">
            {sessionsLoading && <p className="muted empty-sm">Loading…</p>}
            {!sessionsLoading && sessionsList.length === 0 && <p className="muted empty-sm">No saved sessions yet.</p>}
            {sessionsList.map((s) => (
              <div key={s.id} className={`assistant-sessions-panel__row${s.id === sessionId ? ' assistant-sessions-panel__row--active' : ''}`}>
                <button className="assistant-sessions-panel__open" onClick={() => loadSession(s.id)}>
                  <span className="assistant-sessions-panel__name">{s.name}</span>
                  <span className="assistant-sessions-panel__time muted">
                    {timeAgo(new Date(s.updatedAt).getTime() / 1000)}
                  </span>
                </button>
                <button
                  className="btn btn--ghost btn--sm"
                  title="Delete session"
                  onClick={() => deleteSessionRow(s.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="assistant-log" ref={logRef}>
          {log.length === 0 && (
            <p className="muted empty-sm">
              Try: "create a lambda function that sorts strings and attach a gateway endpoint to it"
            </p>
          )}
          {log.map((entry, i) => (
            <p key={i} className={`assistant-log__entry assistant-log__entry--${entry.kind}`}>
              {entry.text}
            </p>
          ))}
          {error && <p className="assistant-log__entry assistant-log__entry--error">{error}</p>}
        </div>

        {pending.map((action) => {
          const destructive = DESTRUCTIVE.has(action.name);
          const fields = edits[action.id] ?? action.input;
          return (
            <div key={action.id} className={`pending-action-card${destructive ? ' pending-action-card--destructive' : ''}`}>
              <h4>
                {destructive && '⚠️ '}
                {ACTION_LABEL[action.name] ?? action.name}
              </h4>
              {Object.keys(fields).length === 0 && <p className="hint">No parameters — takes effect immediately on confirm.</p>}
              {Object.entries(fields).map(([key, value]) => (
                <label className="field" key={key}>
                  <span>{key}</span>
                  {key === 'code' || key === 'content' ? (
                    <textarea
                      rows={8}
                      spellCheck={false}
                      value={String(value ?? '')}
                      onChange={(e) => editField(action.id, key, e.target.value)}
                    />
                  ) : typeof value === 'object' && value !== null ? (
                    <textarea
                      rows={4}
                      spellCheck={false}
                      value={JSON.stringify(value, null, 2)}
                      onChange={(e) => editJsonField(action.id, key, e.target.value)}
                    />
                  ) : typeof value === 'boolean' ? (
                    <input
                      type="checkbox"
                      checked={value}
                      onChange={(e) => editField(action.id, key, e.target.checked)}
                    />
                  ) : (
                    <input value={String(value ?? '')} onChange={(e) => editField(action.id, key, e.target.value)} />
                  )}
                </label>
              ))}
              <div className="pending-action-card__actions">
                <button
                  className={`btn btn--sm ${destructive ? 'btn--danger' : 'btn--primary'}`}
                  disabled={busy}
                  onClick={() => decide(action, true)}
                >
                  Confirm
                </button>
                <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => decide(action, false)}>
                  Cancel
                </button>
              </div>
            </div>
          );
        })}

        {pending.length === 0 && (
          <div className="assistant-input">
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && ask()}
              placeholder="Describe what to create..."
              disabled={busy}
              autoFocus
            />
            <button className="btn btn--primary" disabled={busy || !prompt.trim()} onClick={ask}>
              {busy ? 'Thinking…' : 'Ask'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
