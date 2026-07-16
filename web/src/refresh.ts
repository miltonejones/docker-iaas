// Lightweight pub/sub for "data may have changed" notifications.
//
// The Ask Dockyard assistant mutates resources (functions, gateway routes,
// buckets, containers) via confirmed tool calls. After a tool executes it
// calls onChanged, which emits here. Each page that owns data subscribes and
// re-runs its loader, so whatever page the user is currently on refreshes
// itself without the assistant needing to know which page is mounted.

type Listener = () => void;

const listeners = new Set<Listener>();

/** Subscribe to data-changed notifications. Returns an unsubscribe function. */
export function onRefresh(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Notify every subscribed page that its data may be stale and should be
 *  reloaded. Safe to call from anywhere; listener errors are isolated. */
export function emitRefresh(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // A single page's reload failure shouldn't stop the others.
    }
  }
}