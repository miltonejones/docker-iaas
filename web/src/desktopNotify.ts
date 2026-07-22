// Thin wrapper around the browser's Notification API
// (https://developer.mozilla.org/en-US/docs/Web/API/Notification) so Dockyard
// can fire OS-level desktop notifications for issue/consumer lifecycle events
// even when the tab is backgrounded or unfocused. This is the in-browser
// replacement for the SSH-based scripts/notify-watcher.mjs desktop script.

const PERMISSION_KEY = 'dockyard.notifications.desktopPermission';

export type DesktopPermission = NotificationPermission | 'unsupported';

/** Whether this browser supports the Notification API at all. */
export function isDesktopNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** Current permission state ('default' | 'granted' | 'denied' | 'unsupported'). */
export function getDesktopPermission(): DesktopPermission {
  if (!isDesktopNotificationSupported()) return 'unsupported';
  return Notification.permission;
}

/** Ask the browser for permission to show desktop notifications.
 *  Must be called from a user gesture (e.g. a button click) in most browsers. */
export async function requestDesktopPermission(): Promise<DesktopPermission> {
  if (!isDesktopNotificationSupported()) return 'unsupported';
  try {
    const result = await Notification.requestPermission();
    localStorage.setItem(PERMISSION_KEY, result);
    return result;
  } catch {
    return Notification.permission;
  }
}

/** Fire an OS-level desktop notification if permission has been granted.
 *  No-ops (with a console warning) when unsupported or not permitted so the
 *  failure reason is always visible in the browser console. */
export function showDesktopNotification(summary: string, body?: string): void {
  const perm = getDesktopPermission();
  if (perm !== 'granted') {
    console.warn(
      `[Dockyard] Skipped desktop notification — permission is "${perm}".`,
      'Click the bell → "Enable desktop alerts" to grant it.',
    );
    return;
  }
  try {
    const n = new Notification(summary, {
      body: body || undefined,
      icon: '/favicon.svg',
      tag: `dockyard-${summary}`,
    });
    // Focus the tab when the user clicks the notification.
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch (err) {
    // Some environments (e.g. certain mobile browsers) throw on `new Notification`
    // even when permission is granted and require the ServiceWorkerRegistration
    // API instead; log the error for diagnosis rather than failing silently.
    console.error('[Dockyard] Failed to show desktop notification', err);
  }
}
