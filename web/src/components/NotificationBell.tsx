import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { subscribeNotifications, type NotificationEntry } from '../api';
import { AppIcon } from '../icons';
import { useToast } from '../ToastContext';
import {
  getDesktopPermission,
  isDesktopNotificationSupported,
  requestDesktopPermission,
  showDesktopNotification,
  type DesktopPermission,
} from '../desktopNotify';

const MAX_STORED = 200;
const SEEN_KEY = 'dockyard.notifications.lastSeenTs';

/** Map an emoji-prefixed summary (see scripts/notify-watcher.mjs) to a toast kind. */
function kindFor(summary: string): 'success' | 'error' | 'info' {
  if (summary.startsWith('✅')) return 'success';
  if (summary.startsWith('❌') || summary.startsWith('🐛')) return 'error';
  return 'info';
}

/** Map an emoji-prefixed summary to an icon, mirroring notify-watcher.mjs's pickIcon(). */
function iconFor(summary: string): string {
  if (summary.startsWith('🐛')) return 'warning';
  if (summary.startsWith('🚀')) return 'function';
  if (summary.startsWith('✅')) return 'check';
  if (summary.startsWith('❌')) return 'warning';
  return 'info';
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Bell icon in the topbar that surfaces live consumer/issue events pushed
 *  over SSE from the server's notification log — the same event stream the
 *  desktop notify-watcher.mjs script tails via SSH. */
export function NotificationBell() {
  const [entries, setEntries] = useState<NotificationEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [lastSeenTs, setLastSeenTs] = useState<string>(() => localStorage.getItem(SEEN_KEY) || '');
  const toast = useToast();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const initialized = useRef(false);
  // Highest entry timestamp we've already surfaced a toast/desktop notification
  // for. EventSource silently reconnects on any network hiccup or server
  // redeploy, and each reconnect re-sends the full backlog as a fresh
  // "history" frame rather than one "entry" frame per new item. Without this
  // tracker, entries delivered via a post-reconnect history resync would
  // still populate the dropdown (setEntries always runs) but would never
  // reach the toast/showDesktopNotification calls below, which historically
  // only fired for the "entry" SSE frame.
  const lastNotifiedTs = useRef('');
  const [desktopPermission, setDesktopPermission] = useState<DesktopPermission>(() =>
    getDesktopPermission(),
  );

  const notify = useCallback(
    (entry: NotificationEntry) => {
      toast.show(entry.summary, kindFor(entry.summary));
      // Fire an OS-level desktop notification too, so issue/consumer
      // activity is visible even when this tab is backgrounded or
      // unfocused (see desktopNotify.ts). This is the in-browser
      // replacement for scripts/notify-watcher.mjs.
      showDesktopNotification(entry.summary, entry.body);
    },
    // toast.show is itself a stable useCallback (its only dependency,
    // dismiss, is also stable), so depending on it instead of the whole
    // toast object prevents notify from changing every render.  If the
    // whole toast object is a dependency, the SSE EventSource effect
    // below resubscribes on every render (creating a new EventSource
    // each time), which means the connection never lives long enough to
    // receive a live "entry" frame — only the initial "history" frame
    // arrives, and lastNotifiedTs filters that out as already-seen.
    // That is why OS desktop notifications never fire.
    [toast.show],
  );

  useEffect(() => {
    const unsubscribe = subscribeNotifications(
      (history) => {
        const sliced = history.slice(-MAX_STORED);
        setEntries(sliced);
        if (initialized.current) {
          // Reconnect: any entries newer than the last one we notified about
          // arrived while we were disconnected (or were bundled into this
          // resync instead of a live "entry" frame) — notify for those too.
          for (const entry of sliced) {
            if (entry.ts > lastNotifiedTs.current) notify(entry);
          }
        }
        if (sliced.length > 0) lastNotifiedTs.current = sliced[sliced.length - 1].ts;
        initialized.current = true;
      },
      (entry) => {
        setEntries((list) => [...list, entry].slice(-MAX_STORED));
        // Only notify entries that arrive live, not the initial catch-up history.
        if (initialized.current && entry.ts > lastNotifiedTs.current) {
          notify(entry);
          lastNotifiedTs.current = entry.ts;
        }
      },
    );
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notify]);

  const requestPermission = useCallback(async () => {
    const result = await requestDesktopPermission();
    setDesktopPermission(result);
  }, []);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  // Browsers refuse to show the native permission prompt unless it's triggered
  // by a user gesture (click/keydown), so a prompt can never fire automatically
  // on page load. Instead, ask for permission on the user's first interaction
  // with the page (if we haven't asked before), so a reload doesn't require
  // hunting down the bell's "Enable desktop alerts" button to see the prompt.
  useEffect(() => {
    if (!isDesktopNotificationSupported() || getDesktopPermission() !== 'default') return;
    const onFirstInteraction = () => {
      requestPermission();
      document.removeEventListener('click', onFirstInteraction);
      document.removeEventListener('keydown', onFirstInteraction);
    };
    document.addEventListener('click', onFirstInteraction, { once: true });
    document.addEventListener('keydown', onFirstInteraction, { once: true });
    return () => {
      document.removeEventListener('click', onFirstInteraction);
      document.removeEventListener('keydown', onFirstInteraction);
    };
  }, [requestPermission]);

  const unreadCount = useMemo(
    () => entries.filter((e) => e.ts > lastSeenTs).length,
    [entries, lastSeenTs],
  );

  const toggle = useCallback(() => {
    setOpen((o) => {
      const next = !o;
      if (next && entries.length > 0) {
        const latest = entries[entries.length - 1].ts;
        setLastSeenTs(latest);
        localStorage.setItem(SEEN_KEY, latest);
      }
      return next;
    });
  }, [entries]);

  const ordered = useMemo(() => [...entries].reverse(), [entries]);

  return (
    <div className="notif-bell" ref={rootRef}>
      <button
        className="btn btn--ghost btn--sm notif-bell__trigger"
        onClick={toggle}
        title="Notifications"
        aria-label="Notifications"
      >
        <AppIcon name="bell" />
        {unreadCount > 0 && (
          <span className="notif-bell__badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
        )}
      </button>
      {open && (
        <div className="notif-panel">
          <div className="notif-panel__head">
            <h3>Notifications</h3>
            {isDesktopNotificationSupported() && desktopPermission === 'default' && (
              <button
                type="button"
                className="btn btn--ghost btn--sm notif-panel__desktop-btn"
                onClick={requestPermission}
                title="Get OS-level desktop notifications, even when this tab isn't focused"
              >
                Enable desktop alerts
              </button>
            )}
            {isDesktopNotificationSupported() && desktopPermission === 'denied' && (
              <span className="muted notif-panel__desktop-status">
                Desktop alerts blocked — enable in browser settings
              </span>
            )}
            {isDesktopNotificationSupported() && desktopPermission === 'granted' && (
              <span className="muted notif-panel__desktop-status">Desktop alerts on</span>
            )}
          </div>
          <div className="notif-panel__body">
            {ordered.length === 0 && <p className="muted empty-sm">No notifications yet.</p>}
            {ordered.map((e, i) => (
              <div key={`${e.ts}-${i}`} className={`notif-row notif-row--${kindFor(e.summary)}`}>
                <span className="notif-row__icon">
                  <AppIcon name={iconFor(e.summary) as never} />
                </span>
                <div className="notif-row__body">
                  <div className="notif-row__summary">{e.summary}</div>
                  {e.body && <div className="notif-row__detail muted">{e.body}</div>}
                  <div className="notif-row__time muted">{formatTime(e.ts)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
