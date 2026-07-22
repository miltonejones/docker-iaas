// Lightweight pub/sub for "open the assistant with this prompt" requests.
//
// Detail pages (containers, functions, buckets, gateway routes, database
// connections) surface an info icon that should pop open the Ask Dockyard
// assistant pre-loaded with a prompt explaining the object being viewed.
// Rather than prop-drilling an "open assistant" callback through every
// layout, pages call emitOpenAssistant() and the top-level App (which owns
// the assistant modal state) subscribes once via onOpenAssistant().

type Listener = (prompt: string) => void;

const listeners = new Set<Listener>();

/** Subscribe to "open assistant" requests. Returns an unsubscribe function. */
export function onOpenAssistant(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Request that the assistant open (or refocus) with the given prompt. */
export function emitOpenAssistant(prompt: string): void {
  for (const fn of listeners) {
    try {
      fn(prompt);
    } catch {
      // A single listener failure shouldn't block the others.
    }
  }
}
