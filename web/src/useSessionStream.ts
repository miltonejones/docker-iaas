import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type {
  AssistantSessionState,
  AssistantLogEntry,
} from "./types";

export interface SessionStreamState {
  log: AssistantLogEntry[];
  messages: unknown[];
  pending: unknown[];
  resolved: unknown[];
  busy: boolean;
  error: string | null;
  sessionId: string | null;
  running: boolean; // server-side runner is active
}

export function useSessionStream(
  initialSessionId?: string,
  initialPrompt?: string,
) {
  const [state, setState] = useState<SessionStreamState>({
    log: [],
    messages: [],
    pending: [],
    resolved: [],
    busy: false,
    error: null,
    sessionId: initialSessionId ?? null,
    running: false,
  });

  const esRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const firedInitialPrompt = useRef(false);

  // Subscribe to SSE for a given session ID.
  const subscribe = useCallback((sessionId: string) => {
    // Close any existing stream
    esRef.current?.close();

    sessionIdRef.current = sessionId;
    const es = api.assistantSessionStream(sessionId);
    esRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case "state":
            setState((s) => ({
              ...s,
              messages: data.messages || [],
              log: data.log || [],
              pending: data.pending || [],
              resolved: data.resolved || [],
            }));
            break;
          case "status":
            setState((s) => ({ ...s, running: data.running }));
            break;
          case "text":
            setState((s) => ({
              ...s,
              busy: true,
              log: appendDelta(s.log, data.delta),
            }));
            break;
          case "turn": {
            setState((s) => {
              const logMsg = data.text
                ? appendEntry(s.log, "assistant", data.text)
                : s.log;
              // Add pending actions
              const actions: AssistantLogEntry[] = (data.pending || []).map(
                (p: unknown) => ({
                  kind: "action" as const,
                  text: (p as { name: string }).name || "Confirm action",
                }),
              );
              return {
                ...s,
                messages: data.messages || s.messages,
                pending: data.pending || [],
                resolved: data.resolved || s.resolved,
                log: [...logMsg, ...actions],
                busy: !data.done,
              };
            });
            break;
          }
          case "error":
            setState((s) => ({
              ...s,
              error: data.error || "Unknown error",
              busy: false,
            }));
            break;
          case "done":
            setState((s) => ({ ...s, busy: false, running: false }));
            break;
        }
      } catch {
        // skip unparseable
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; just mark not-running
      setState((s) => ({ ...s, running: false }));
    };
  }, []);

  // Send a user message to the session.
  const send = useCallback(
    async (prompt: string) => {
      const sid = sessionIdRef.current;
      if (!sid) return;

      setState((s) => ({
        ...s,
        busy: true,
        error: null,
        log: appendEntry(s.log, "user", prompt),
      }));

      try {
        await api.assistantSessionSend(sid, {
          prompt,
          state: snapshotState(),
        });
      } catch (err) {
        setState((s) => ({
          ...s,
          error: (err as Error).message,
          busy: false,
        }));
      }
    },
    [],
  );

  // Confirm/decline tool calls.
  const confirmTools = useCallback(
    async (results: { toolUseId: string; ok: boolean; content: unknown }[]) => {
      const sid = sessionIdRef.current;
      if (!sid) return;

      setState((s) => ({ ...s, busy: true, error: null }));

      try {
        await api.assistantSessionSend(sid, {
          results,
          state: snapshotState(),
        });
      } catch (err) {
        setState((s) => ({
          ...s,
          error: (err as Error).message,
          busy: false,
        }));
      }
    },
    [],
  );

  // Abort current turn.
  const abort = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid) api.assistantSessionAbort(sid);
    setState((s) => ({ ...s, busy: false }));
  }, []);

  // Create a new session or subscribe to an existing one.
  const init = useCallback(
    async (sessionId?: string, prompt?: string) => {
      const sid = sessionId || sessionIdRef.current;
      if (!sid) {
        // Create a new session
        const name = prompt?.slice(0, 60) || "New session";
        const created = await api.assistantCreateSession(name, {
          messages: [],
          log: [],
          pending: [],
          resolved: [],
        });
        sessionIdRef.current = created.id;
        setState((s) => ({ ...s, sessionId: created.id }));
        subscribe(created.id);
        if (prompt) send(prompt);
      } else {
        subscribe(sid);
      }
    },
    [subscribe, send],
  );

  // Fire initial prompt once.
  useEffect(() => {
    if (firedInitialPrompt.current) return;
    if (!initialSessionId && !initialPrompt) return;
    firedInitialPrompt.current = true;
    init(initialSessionId, initialPrompt);
  }, [initialSessionId, initialPrompt, init]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  function snapshotState(): AssistantSessionState {
    return {
      messages: state.messages,
      log: state.log,
      pending: state.pending as AssistantSessionState["pending"],
      resolved: state.resolved as AssistantSessionState["resolved"],
    };
  }

  return {
    ...state,
    sessionId: state.sessionId,
    send,
    confirmTools,
    abort,
    subscribe,
    init,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function appendEntry(log: AssistantLogEntry[], kind: AssistantLogEntry["kind"], text: string): AssistantLogEntry[] {
  return [...log, { kind, text }];
}

function appendDelta(log: AssistantLogEntry[], delta: string): AssistantLogEntry[] {
  if (log.length === 0) return [{ kind: "assistant", text: delta }];
  const last = log[log.length - 1];
  if (last.kind === "assistant") {
    return [...log.slice(0, -1), { ...last, text: last.text + delta }];
  }
  return [...log, { kind: "assistant" as const, text: delta }];
}
