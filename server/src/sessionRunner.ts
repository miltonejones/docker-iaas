import { EventEmitter } from "node:events";
import Anthropic from "@anthropic-ai/sdk";
import {
  getAssistantSession,
  updateAssistantSession,
  createAssistantSession,
} from "./db.js";

// Re-exported from assistant.ts — defined there because of tool/constant binding.
// We receive these as constructor parameters to avoid a circular import.
type RespondStreamFn = (
  messages: Anthropic.MessageParam[],
  onEvent: (event: SessionEvent) => void,
  signal: AbortSignal,
) => Promise<void>;

// ── Types ────────────────────────────────────────────────────────────────────

export interface SessionEvent {
  type: "text" | "turn" | "error" | "done" | "wait";
  delta?: string;
  messages?: unknown[];
  pending?: unknown[];
  autoResolved?: unknown[];
  done?: boolean;
  text?: string;
  error?: string;
  /** Wait-tool fields: emitted before the server-side sleep so the client can
   *  show a countdown. */
  seconds?: number;
  reason?: string;
  toolUseId?: string;
}

export interface SessionState {
  messages: unknown[];
  log: unknown[];
  pending: unknown[];
  resolved: unknown[];
}

// ── Session Runner ───────────────────────────────────────────────────────────

export class SessionRunner extends EventEmitter {
  readonly id: string;
  readonly userId?: string;
  private respondStream: RespondStreamFn;
  private abortController: AbortController | null = null;
  private busy = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly IDLE_MS = 5 * 60_000; // 5 min
  private readonly client: Anthropic;

  constructor(
    id: string,
    userId: string | undefined,
    respondStream: RespondStreamFn,
    client: Anthropic,
  ) {
    super();
    this.id = id;
    this.userId = userId;
    this.respondStream = respondStream;
    this.client = client;
    this.setMaxListeners(50); // support many subscribers
  }

  /** Load persisted state from DB, or create an empty session. */
  static async load(
    id: string,
    name: string,
    userId: string | undefined,
    respondStream: RespondStreamFn,
    client: Anthropic,
  ): Promise<SessionRunner> {
    let row = getAssistantSession(id, userId);
    if (!row) {
      row = createAssistantSession(id, name, JSON.stringify({ messages: [], log: [], pending: [], resolved: [] }), userId);
    }
    return new SessionRunner(id, userId, respondStream, client);
  }

  get isRunning(): boolean {
    return this.busy;
  }

  /** Persist the session state to the DB. */
  private persistState(state: SessionState): void {
    try {
      updateAssistantSession(this.id, { state: JSON.stringify(state) });
    } catch {
      // best-effort
    }
  }

  /** Reset the idle timer — called on any activity. */
  private resetIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.destroy(), this.IDLE_MS);
  }

  /** Broadcast an event to all subscribers (registered via this.on(...)). */
  private broadcast(event: SessionEvent): void {
    this.emit("event", event);
  }

  /** Send a user message + tool results and start the next LLM turn. */
  async send(
    state: SessionState,
    userMessage?: string,
    toolResults?: { toolUseId: string; ok: boolean; content: unknown }[],
  ): Promise<void> {
    if (this.busy) {
      this.broadcast({ type: "error", error: "Session is already processing." });
      return;
    }

    this.busy = true;
    this.resetIdle();
    this.abortController = new AbortController();

    const messages: Anthropic.MessageParam[] = [...state.messages] as Anthropic.MessageParam[];

    if (userMessage) {
      messages.push({ role: "user", content: userMessage.trim() });
    }

    if (toolResults?.length) {
      messages.push({
        role: "user",
        content: toolResults.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.toolUseId,
          content: typeof r.content === "string" ? r.content : JSON.stringify(r.content ?? {}),
          is_error: !r.ok,
        })),
      });
    }

    try {
      await this.respondStream(messages, (event) => this.broadcast(event), this.abortController.signal);
    } catch (err) {
      if (!this.abortController.signal.aborted) {
        this.broadcast({ type: "error", error: (err as Error).message });
      }
    } finally {
      this.busy = false;
      this.abortController = null;
      this.broadcast({ type: "done" });
    }
  }

  /** Abort the current LLM turn. */
  abort(): void {
    this.abortController?.abort();
  }

  /** Generate a title for the session from the first exchange. */
  async generateTitle(firstUser: string, lastAssistant: string): Promise<string> {
    const TITLE_MODEL = process.env.DEEPSEEK_TITLE_MODEL || process.env.ANTHROPIC_TITLE_MODEL || "claude-haiku-4-5";
    try {
      const resp = await this.client.messages.create({
        model: TITLE_MODEL,
        max_tokens: 50,
        system: "Reply with a short title (6 words max) summarizing this conversation. No quotes, no punctuation at the end.",
        messages: [
          { role: "user", content: firstUser },
          { role: "assistant", content: lastAssistant?.slice(0, 500) || "Done." },
        ],
      });
      const title = (resp.content[0] as Anthropic.TextBlock).text.trim();
      updateAssistantSession(this.id, { name: title });
      return title;
    } catch {
      return firstUser.slice(0, 60);
    }
  }

  /** Clean up resources and remove from the active sessions map. */
  destroy(): void {
    this.abort();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.removeAllListeners();
    sessionRegistry.delete(this.id);
  }
}

// ── Global registry ──────────────────────────────────────────────────────────

export const sessionRegistry = new Map<string, SessionRunner>();

export function getOrCreateSession(
  id: string,
  name: string,
  userId: string | undefined,
  respondStream: RespondStreamFn,
  client: Anthropic,
): SessionRunner {
  let runner = sessionRegistry.get(id);
  if (!runner) {
    runner = new SessionRunner(id, userId, respondStream, client);
    sessionRegistry.set(id, runner);
    // Load persisted state from DB — fire and forget
    getAssistantSession(id, userId);
  }
  return runner;
}
