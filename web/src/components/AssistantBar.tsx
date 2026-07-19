import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AppIcon } from '../icons';
import { api } from '../api';
import { timeAgo } from '../format';
import type {
  AssistantLogEntry,
  AssistantPendingAction,
  AssistantResolvedResult,
  AssistantSessionState,
  AssistantSessionSummary,
  AssistantTurn,
  LambdaFile,
} from '../types';

type LogEntry = AssistantLogEntry;
type ResolvedResult = AssistantResolvedResult;

const ACTION_LABEL: Record<string, string> = {
  create_lambda_function: 'Create Lambda function',
  create_gateway_route: 'Create Gateway route',
  update_lambda_function: 'Update Lambda function',
  replace_lambda_function_files: 'Update function files',
  delete_lambda_function: 'Delete Lambda function',
  delete_gateway_route: 'Delete Gateway route',
  launch_container: 'Launch container',
  container_action: 'Container action',
  write_container_file: 'Write container file',
  execute_container_command: 'Run container command',
  copy_host_file_to_container: 'Copy host file to container',
  delete_container: 'Delete container',
  delete_image: 'Delete image',
  prune_images: 'Prune unused images',
  create_bucket: 'Create bucket',
  delete_bucket: 'Delete bucket',
  delete_bucket_object: 'Delete bucket object',
  write_bucket_object: 'Write bucket file',
  copy_host_file_to_bucket: 'Copy host file to bucket',
  run_host_build_preset: 'Build host project and deploy artifacts',
  prune_build_cache: 'Prune build cache',
  run_function: 'Run function',
  create_database_connection: 'Create database connection',
  update_database_connection: 'Update database connection',
  delete_database_connection: 'Delete database connection',
  test_database_connection: 'Test database connection',
  execute_database_mutation: 'Execute database mutation',
  execute_database_migration: 'Execute database migration',
  execute_database_access_grant: 'Grant database access',
  create_database_backup: 'Create database backup',
  restore_database_backup: 'Restore database backup',
  pull_github_repo_to_bucket: 'Pull GitHub repo into bucket',
  pull_github_repo_to_container: 'Pull GitHub repo into container',
  commit_and_push_github_files: 'Commit and push to GitHub',
  update_container_env: 'Update container env vars',
  replace_in_container_file: 'Replace text in container file',
  replace_in_bucket_object: 'Replace text in bucket file',
  write_container_files: 'Write container files',
  write_bucket_objects: 'Write bucket files',
};

const LOOKUP_LABEL: Record<string, string> = {
  list_containers: 'containers',
  list_functions: 'functions',
  list_gateway_routes: 'gateway routes',
  list_buckets: 'buckets',
  list_images: 'images',
  list_bucket_objects: 'bucket contents',
  read_bucket_object: 'file content',
  list_host_build_presets: 'host build presets',
  list_github_repo_files: 'GitHub repo contents',
  read_github_file: 'GitHub file content',
};

const THINKING_WORDS = [
  'Discombobulating',
  'Anthropomorphizing',
  'Contemplating',
  'Percolating',
  'Cogitating',
  'Ruminating',
  'Synthesizing',
  'Extrapolating',
  'Calibrating',
  'Orchestrating',
  'Pondering',
  'Musing',
  'Reasoning',
  'Analyzing',
  'Investigating',
  'Deciphering',
  'Untangling',
  'Deconstructing',
  'Reconstructing',
  'Formulating',
  'Harmonizing',
  'Optimizing',
  'Prioritizing',
  'Contextualizing',
  'Correlating',
  'Triangulating',
  'Interpolating',
  'Refactoring',
  'Compiling',
  'Indexing',
  'Mapping',
  'Modeling',
  'Simulating',
  'Iterating',
  'Prototyping',
  'Evaluating',
  'Validating',
  'Reconciling',
  'Translating',
  'Navigating',
  'Sifting',
  'Scouting',
  'Surveying',
  'Scrutinizing',
  'Illuminating',
  'Connecting',
  'Converging',
  'Conjuring',
  'Galvanizing',
  'Unspooling',
];

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

function parseLambdaFiles(value: unknown): LambdaFile[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Function files must be an array.');
  return value.map((file) => {
    if (
      !file ||
      typeof file !== 'object' ||
      typeof (file as Record<string, unknown>).path !== 'string' ||
      typeof (file as Record<string, unknown>).content !== 'string'
    ) {
      throw new Error('Each function file needs a path and content.');
    }
    const { path, content } = file as { path: string; content: string };
    return { path, content };
  });
}

interface Props {
  onClose?: () => void;
  onPin?: () => void;
  /** Called after any create so pages showing that data can refresh next time they mount. */
  onChanged?: () => void;
  /** A prompt already submitted from the toolbar search box — run it
   *  immediately on mount instead of waiting for the user to type it again. */
  initialPrompt?: string;
  /** If set, load this saved session on mount instead of running a new
   *  prompt. Takes precedence over `initialPrompt`. */
  initialSessionId?: string;
  /** Renders the assistant inside a page panel rather than a modal. */
  embedded?: boolean;
  /** Context added to every request without exposing it in the visible chat log. */
  contextPrompt?: string;
  /** Browser storage key for resuming the latest session in an embedded assistant. */
  sessionStorageKey?: string;
  /** Called when the active session id changes so the parent can track it.
   *  Passed `null` when the session is reset to a fresh (unsaved) state. */
  onSessionId?: (id: string | null) => void;
}

export function AssistantBar({
  onClose,
  onPin,
  onChanged,
  initialPrompt,
  initialSessionId,
  embedded = false,
  contextPrompt,
  sessionStorageKey,
  onSessionId,
}: Props) {
  const [prompt, setPrompt] = useState('');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [rawMessages, setRawMessages] = useState<unknown[]>([]);
  const [pending, setPending] = useState<AssistantPendingAction[]>([]);
  const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>({});
  const [resolved, setResolved] = useState<ResolvedResult[]>([]);
  const [autoApprove, setAutoApprove] = useState(false);
  const [activeActionName, setActiveActionName] = useState<string | null>(null);
  const [thinkingWord, setThinkingWord] = useState(() => THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)]);
  const [copiedMessage, setCopiedMessage] = useState<number | null>(null);
  const [expandedActions, setExpandedActions] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keep the active conversation on its newest streamed or newly added entry.
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [embedded, log, error, pending, busy]);
  useEffect(() => {
    if (!busy) return;
    const rotate = () => {
      setThinkingWord((current) => {
        const alternatives = THINKING_WORDS.filter((word) => word !== current);
        return alternatives[Math.floor(Math.random() * alternatives.length)];
      });
    };
    rotate();
    const interval = window.setInterval(rotate, 1800);
    return () => window.clearInterval(interval);
  }, [busy]);
  // Guards the initial-prompt effect below against React StrictMode's
  // dev-only double-invoke of effects (mount → cleanup → mount) — without
  // this, the same prompt gets submitted twice and comes back with two
  // separate answers. The ref survives that double-invoke since only the
  // effect (not the component instance) is torn down and rerun.
  const firedInitialPrompt = useRef(false);
  const titleGeneratedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(null);

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
        if (!sessionIdRef.current) {
          const custom = sessionName.trim();
          const name = custom || deriveSessionName(log);
          const created = await api.assistantCreateSession(name, state);
          if (cancelled) return;
          sessionIdRef.current = created.id;
          setSessionId(created.id);
          setSessionName(created.name);
          onSessionId?.(created.id);
          if (sessionStorageKey) localStorage.setItem(sessionStorageKey, created.id);
          // If the user didn't name it themselves, ask Claude for a friendly
          // title and rename the session once. Best-effort and non-blocking —
          // saving already completed with the placeholder name, so a failure
          // here just leaves the truncated-first-message heuristic in place.
          // Uses a ref guard so the title update survives useEffect re-runs
          // (which would otherwise cancel the in-flight request when busy
          // changes).
          if (!custom && !titleGeneratedRef.current) {
            titleGeneratedRef.current = true;
            const firstUser = log.find((e) => e.kind === 'user')?.text ?? '';
            const lastAssistant = [...log].reverse().find((e) => e.kind === 'assistant')?.text ?? '';
            api
              .assistantGenerateTitle(firstUser, lastAssistant)
              .then(({ name: title }) => {
                if (!title) return;
                setSessionName(title);
                return api.assistantUpdateSession(created.id, { name: title });
              })
              .catch(() => {
                /* best-effort: keep the placeholder name */
              });
          }
        } else {
          await api.assistantUpdateSession(sessionId!, { state });
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
  }, [rawMessages, log, pending, resolved, busy, sessionStorageKey]);

  function resetToNewSession() {
    if (sessionStorageKey) localStorage.removeItem(sessionStorageKey);
    titleGeneratedRef.current = false;
    sessionIdRef.current = null;
    setSessionId(null);
    onSessionId?.(null);
    setSessionName('');
    setPrompt('');
    setLog([]);
    setRawMessages([]);
    setPending([]);
    setEdits({});
    setResolved([]);
    setAutoApprove(false);
    setError(null);
    setSessionsOpen(false);
  }

  async function loadSession(id: string) {
    setError(null);
    try {
      const session = await api.assistantGetSession(id);
      sessionIdRef.current = session.id;
      setSessionId(session.id);
      setSessionName(session.name);
      onSessionId?.(session.id);
      titleGeneratedRef.current = true; // already has a name
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


  function cancelTurn() {
    abortRef.current?.abort();
    abortRef.current = null;
    setLog((l) => [...l, { kind: 'action', text: 'Cancelled' }]);
    setPending([]);
    setRawMessages([]);
    setBusy(false);
  }

  async function askWithText(text: string) {
    setBusy(true);
    setError(null);
    setLog((l) => [...l, { kind: 'user', text }]);
    setPrompt('');
    try {
      const aborter = new AbortController();
      abortRef.current = aborter;
      const request = contextPrompt
        ? `${contextPrompt}\n\nUser request: ${text}`
        : text;
      const stream = await api.assistantPlanStream(request, rawMessages, abortRef.current!.signal);
      await consumeTurnStream(stream);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function ask() {
    const text = prompt.trim();
    if (!text) return;
    if (busy) cancelTurn();
    await askWithText(text);
  }

  // Load an explicitly selected session or the last saved embedded session.
  // An explicit session takes precedence over the per-function stored session.
  useEffect(() => {
    const savedSessionId = initialSessionId ?? (
      sessionStorageKey ? localStorage.getItem(sessionStorageKey) : null
    );
    if (!savedSessionId) return;
    const sessionToLoad = savedSessionId;
    let cancelled = false;
    async function load() {
      setBusy(true);
      try {
        const session = await api.assistantGetSession(sessionToLoad);
        if (cancelled) return;
        sessionIdRef.current = session.id;
        setSessionId(session.id);
        setSessionName(session.name);
        onSessionId?.(session.id);
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
        if (sessionStorageKey && localStorage.getItem(sessionStorageKey) === savedSessionId) {
          localStorage.removeItem(sessionStorageKey);
        }
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
  }, [initialSessionId, sessionStorageKey]);

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
          files: parseLambdaFiles(input.files),
        });

      case 'replace_lambda_function_files': {
        const entryPoint = String(input.entryPoint ?? '');
        const files = parseLambdaFiles(input.files);
        if (!files) throw new Error('Function files are required.');
        const entryFile = files.find((file) => file.path === entryPoint);
        if (!entryFile) throw new Error('Function files must include the entry point.');
        return api.lambdaUpdateFunction(String(input.id ?? ''), {
          entryPoint,
          code: entryFile.content,
          files: files.filter((file) => file.path !== entryPoint),
        });
      }

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
          command: Array.isArray(input.command) && input.command.every((p) => typeof p === 'string')
            ? (input.command as string[])
            : undefined,
          ports: Array.isArray(input.ports) ? (input.ports as { container: string; host: number }[]) : undefined,
          env: Array.isArray(input.env) ? (input.env as { key: string; value: string }[]) : undefined,
          autoStart: true,
          assistantManaged: true,
        });

      case 'container_action':
        return api.action(String(input.id ?? ''), input.action as 'start' | 'stop' | 'restart');

      case 'write_container_file':
        return api.containerWriteFile(
          String(input.id ?? ''),
          String(input.path ?? ''),
          String(input.content ?? ''),
        );

      case 'execute_container_command':
        if (!Array.isArray(input.command) || input.command.some((part) => typeof part !== 'string')) {
          throw new Error('Container command must be an array of string arguments.');
        }
        return api.containerExec(
          String(input.id ?? ''),
          input.command as string[],
          str(input.workingDir),
          bool(input.background),
        );

      case 'copy_host_file_to_container':
        return api.hostFileToContainer(
          String(input.sourcePath ?? ''),
          String(input.id ?? ''),
          String(input.path ?? ''),
        );

      case 'update_container_env':
        if (!Array.isArray(input.env) || input.env.some((e) => typeof (e as { key: string }).key !== 'string')) {
          throw new Error('update_container_env requires an env array of { key, value }.');
        }
        return api.containerUpdateEnv(
          String(input.id ?? ''),
          input.env as { key: string; value: string }[],
          bool(input.persist),
        );

      case 'replace_in_container_file':
        return api.containerReplaceFile(
          String(input.id ?? ''),
          String(input.path ?? ''),
          String(input.search ?? ''),
          String(input.replace ?? ''),
        );

      case 'write_container_files':
        if (!Array.isArray(input.files) || input.files.length === 0) {
          throw new Error('write_container_files requires a non-empty files array.');
        }
        return api.containerWriteFiles(
          String(input.id ?? ''),
          input.files as { path: string; content: string }[],
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

      case 'copy_host_file_to_bucket':
        return api.hostFileToBucket(
          String(input.sourcePath ?? ''),
          String(input.bucket ?? ''),
          String(input.key ?? ''),
          str(input.contentType),
        );

      case 'replace_in_bucket_object':
        return api.bucketReplaceObject(
          String(input.name ?? ''),
          String(input.key ?? ''),
          String(input.search ?? ''),
          String(input.replace ?? ''),
        );

      case 'write_bucket_objects':
        if (!Array.isArray(input.objects) || input.objects.length === 0) {
          throw new Error('write_bucket_objects requires a non-empty objects array.');
        }
        return api.bucketWriteObjects(
          String(input.name ?? ''),
          input.objects as { key: string; content: string; contentType?: string }[],
        );

      case 'run_host_build_preset':
        return api.hostBuildRun(
          String(input.preset ?? ''),
          String(input.id ?? ''),
          String(input.path ?? ''),
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

      case 'create_database_connection':
        return api.databaseCreateConnection({
          name: String(input.name ?? ''),
          engine: input.engine as 'mysql' | 'mongodb',
          config: (input.config ?? {}) as Record<string, unknown>,
        });

      case 'update_database_connection': {
        const { connectionId, ...fields } = input;
        return api.databaseUpdateConnection(String(connectionId ?? ''), {
          name: typeof fields.name === 'string' ? fields.name : undefined,
          engine: typeof fields.engine === 'string' ? fields.engine : undefined,
          config: fields.config && typeof fields.config === 'object' && !Array.isArray(fields.config)
            ? fields.config as Record<string, unknown>
            : undefined,
        });
      }

      case 'delete_database_connection':
        return api.databaseDeleteConnection(String(input.connectionId ?? ''));

      case 'test_database_connection':
        return api.databaseTestConnection(String(input.connectionId ?? ''));

      case 'execute_database_mutation': {
        const { connectionId, ...request } = input;
        return api.databaseMutate(String(connectionId ?? ''), { ...request, confirmed: true });
      }

      case 'execute_database_migration': {
        const { connectionId, ...request } = input;
        return api.databaseMigrate(String(connectionId ?? ''), { ...request, confirmed: true });
      }

      case 'execute_database_access_grant': {
        const { connectionId, ...request } = input;
        return api.databaseGrant(String(connectionId ?? ''), { ...request, confirmed: true });
      }

      case 'create_database_backup': {
        const { connectionId, ...request } = input;
        return api.databaseBackup(String(connectionId ?? ''), { ...request, confirmed: true });
      }

      case 'restore_database_backup': {
        const { connectionId, ...request } = input;
        return api.databaseRestore(String(connectionId ?? ''), { ...request, confirmed: true });
      }

      case 'pull_github_repo_to_bucket':
        return api.githubPullToBucket(
          String(input.owner ?? ''),
          String(input.repo ?? ''),
          String(input.bucket ?? ''),
          str(input.ref),
          str(input.prefix),
          bool(input.clean),
        );

      case 'pull_github_repo_to_container':
        return api.githubPullToContainer(
          String(input.owner ?? ''),
          String(input.repo ?? ''),
          String(input.id ?? ''),
          String(input.path ?? ''),
          str(input.ref),
          bool(input.clean),
        );

      case 'commit_and_push_github_files':
        return api.githubCommitAndPush(
          String(input.owner ?? ''),
          String(input.repo ?? ''),
          String(input.message ?? ''),
          parseLambdaFiles(input.files) ?? [],
          str(input.branch),
        );

      case 'report_issue':
        return api.assistantReportIssue(
          String(input.summary ?? ''),
          str(input.category),
          input.details as Record<string, unknown> | undefined,
        );

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
      const input = edits[action.id] ?? action.input;
      const isStreamingExec =
        action.name === 'execute_container_command' &&
        !(input.background === true || input.background === 'true');

      if (isStreamingExec) {
        try {
          const id = String(input.id ?? '');
          const cmd = input.command as string[];
          const wd = typeof input.workingDir === 'string' ? input.workingDir : undefined;

          if (!Array.isArray(cmd) || cmd.some((part) => typeof part !== 'string')) {
            throw new Error('Container command must be an array of string arguments.');
          }

          setActiveActionName('Running container command');
          let streamed = '';
          setLog((l) => [...l, { kind: 'action', text: `$ ${cmd.join(' ')}\n` }]);

          const stream = await api.containerExecStream(id, cmd, wd);
          let exitCode: number | null = null;
          for await (const event of stream) {
            if (event.type === 'output') {
              streamed += event.text as string;
              setLog((l) => {
                const copy = [...l];
                copy[copy.length - 1] = { kind: 'action', text: `$ ${cmd.join(' ')}\n${streamed}` };
                return copy;
              });
            } else if (event.type === 'done') {
              exitCode = (event.exitCode as number) ?? null;
            } else if (event.type === 'error') {
              throw new Error(event.message as string);
            }
          }

          const finalText = `$ ${cmd.join(' ')}\n${streamed}${streamed ? '\n' : ''}Exit: ${exitCode ?? 'unknown'}`;
          setLog((l) => {
            const copy = [...l];
            copy[copy.length - 1] = { kind: 'action', text: finalText, result: { exitCode, output: streamed } };
            return copy;
          });

          entry = { toolUseId: action.id, ok: true, content: { exitCode, output: streamed } };
        } catch (err) {
          setLog((l) => [...l, { kind: 'error', text: (err as Error).message }]);
          entry = { toolUseId: action.id, ok: false, content: { error: (err as Error).message } };
        }
      } else {
        try {
          setActiveActionName(ACTION_LABEL[action.name] ?? action.name);
          const result = await runAction(action, input);
          setLog((l) => [...l, { kind: 'action', text: `Done: ${ACTION_LABEL[action.name] ?? action.name}`, result }]);
          onChanged?.();
          entry = { toolUseId: action.id, ok: true, content: result };
        } catch (err) {
          setLog((l) => [...l, { kind: 'error', text: (err as Error).message }]);
          entry = { toolUseId: action.id, ok: false, content: { error: (err as Error).message } };
        }
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
      setActiveActionName(null);
      setBusy(false);
      return;
    }

    try {
      if (!abortRef.current) abortRef.current = new AbortController();
      const stream = await api.assistantConfirmStream(rawMessages, nextResolved, abortRef.current.signal);
      await consumeTurnStream(stream);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setError((err as Error).message);
    } finally {
      setActiveActionName(null);
      setBusy(false);
    }
  }

  // Process one action at a time so every tool result is returned to the
  // model in the same order as a manually confirmed conversation.
  useEffect(() => {
    if (!autoApprove || busy || pending.length === 0) return;
    void decide(pending[0], true);
    // decide intentionally reads the current turn state from this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoApprove, busy, pending]);

  function toggleActionResult(index: number) {
    setExpandedActions((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function editField(actionId: string, key: string, value: unknown) {
    setEdits((s) => ({ ...s, [actionId]: { ...s[actionId], [key]: value } }));
  }

  async function copyAssistantMessage(index: number, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessage(index);
      window.setTimeout(() => {
        setCopiedMessage((current) => (current === index ? null : current));
      }, 2_000);
    } catch (err) {
      setError(`Could not copy message: ${(err as Error).message}`);
    }
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
    <div className={embedded ? 'assistant-panel' : 'modal-backdrop'} onClick={embedded ? undefined : onClose}>
      <div
        className={embedded ? 'assistant-panel__content' : 'modal modal--assistant'}
        onClick={embedded ? undefined : (e) => e.stopPropagation()}
      >
        <div className={embedded ? 'assistant-panel__head' : 'modal__head'}>
          <h3>
            <span className="assistant-panel__badge"><AppIcon name="assistant" /></span>
            {embedded ? 'Function assistant' : 'Ask Dockyard.ai'}
          </h3>
          {embedded && (
            <button className="btn btn--ghost btn--sm" onClick={resetToNewSession}>
              <AppIcon name="plus" /> New
            </button>
          )}
          {!embedded && (
            <span style={{ display: 'flex', gap: 4 }}>
              {onPin && (
                <button className="btn btn--ghost" onClick={onPin} title="Pin to workspace" disabled={busy}>
                  <AppIcon name="external" /> Pin
                </button>
              )}
              <button className="btn btn--ghost" onClick={onClose}>
                <AppIcon name="close" /> Close
              </button>
            </span>
          )}
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
                <AppIcon name="plus" /> New
              </button>
              <button className="btn btn--ghost btn--sm" onClick={toggleSessionsList}>
                <AppIcon name="folder" /> Sessions
              </button>
            </div>
          </div>

        {!embedded && sessionsOpen && (
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
                  className="btn btn--ghost btn--sm assistant-sessions-panel__delete"
                  title="Delete session"
                  onClick={() => deleteSessionRow(s.id)}
                >
                  <AppIcon name="close" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="assistant-panel__scroll">
          <div className="assistant-log" ref={logRef}>
            {log.length === 0 && (
              <p className="muted empty-sm">
                {embedded
                  ? 'Ask for an explanation, a review, or a change to this function.'
                  : 'Try: "create a lambda function that sorts strings and attach a gateway endpoint to it"'}
              </p>
            )}
            {log
              // A turn that goes straight to a tool call with no preamble text
              // leaves the streaming placeholder empty — skip rendering it
              // rather than showing an empty bubble.
              .filter((entry) => entry.kind !== 'assistant' || entry.text.trim().length > 0)
              .map((entry, i) => (
                <div key={i} className={`assistant-log__entry assistant-log__entry--${entry.kind}`}>
                  {(entry.kind === 'user' || entry.kind === 'assistant') && (
                    <span className="assistant-log__avatar">
                      <AppIcon name={entry.kind === 'user' ? 'user' : 'assistant'} />
                    </span>
                  )}
                  <div className="assistant-log__body">
                    {entry.kind === 'assistant' ? (
                      <>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
                        <button
                          className="assistant-log__copy"
                          onClick={() => copyAssistantMessage(i, entry.text)}
                          title="Copy assistant message"
                          aria-label="Copy assistant message"
                        >
                          <AppIcon name={copiedMessage === i ? 'check' : 'copy'} />
                          {copiedMessage === i && <span>Copied</span>}
                        </button>
                      </>
                    ) : entry.kind === 'action' ? (
                      <div className="assistant-log__action" onClick={() => toggleActionResult(i)}>
                        <span className="assistant-log__action-chevron">
                          <AppIcon name={expandedActions.has(i) ? 'chevron-down' : 'chevron-right'} />
                        </span>
                        <span><AppIcon name="check" /> {entry.text}</span>
                        {expandedActions.has(i) && entry.result !== undefined && (
                          <pre className="assistant-log__action-result">
                            {typeof entry.result === 'string'
                              ? entry.result
                              : JSON.stringify(entry.result, null, 2)}
                          </pre>
                        )}
                      </div>
                    ) : (
                      entry.text
                    )}
                  </div>
                </div>
              ))}
            {error && (
              <div className="assistant-log__entry assistant-log__entry--error">
                <div className="assistant-log__body"><AppIcon name="warning" /> {error}</div>
              </div>
            )}
            {busy && (
              <div className="assistant-working" role="status">
                <AppIcon name="spinner" className="assistant-working__spinner" />
                {activeActionName ? `Running ${activeActionName} — ${thinkingWord}…` : `${thinkingWord}…`}
              </div>
            )}

          {pending.map((action) => {
          const destructive = DESTRUCTIVE.has(action.name);
          const fields = edits[action.id] ?? action.input;
          return (
            <div key={action.id} className={`pending-action-card${destructive ? ' pending-action-card--destructive' : ''}`}>
              <h4>
                <span className="pending-action-card__icon">
                  <AppIcon name={destructive ? 'warning' : 'tool'} />
                </span>
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

          <label className="assistant-auto-approve">
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={(e) => setAutoApprove(e.target.checked)}
            />
            <span>Auto-approve tool actions</span>
            <span className="muted">(includes destructive actions)</span>
          </label>
          </div>
        </div>

        {(pending.length === 0 || busy || pending.length > 0) && (
          <div className="assistant-input">
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && ask()}
              placeholder="Describe what to create..."
              disabled={busy && pending.length === 0}
              autoFocus
            />
            {busy ? (
              <button className="btn btn--danger assistant-input__send" onClick={cancelTurn} title="Stop assistant">
                <AppIcon name="close" />
              </button>
            ) : (
              <button
                className="btn btn--primary assistant-input__send"
                disabled={!prompt.trim()}
              onClick={ask}
            >
              {busy ? 'Thinking…' : <><AppIcon name="send" /> Ask</>}
            </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
