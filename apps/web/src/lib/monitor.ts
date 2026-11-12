/**
 * Sends browser errors to the API (/api/client-errors), which groups them and emails new ones.
 * At most a few per page view, and never the same one twice.
 */
const sent = new Set<string>();
let budget = 5;

export function reportError(message: string, stack?: string | null) {
  if (!message || budget <= 0) return;
  const key = `${message}|${(stack ?? '').split('\n')[1] ?? ''}`;
  if (sent.has(key)) return;
  sent.add(key);
  budget--;
  try {
    void fetch('/api/client-errors', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message.slice(0, 1000), stack: stack?.slice(0, 8000) ?? null, path: location.pathname }),
    }).catch(() => undefined);
  } catch {
    /* never let reporting break the page */
  }
}

export function installErrorReporting() {
  window.addEventListener('error', (e) => {
    // Failed <script>/<img> loads have no error object and say nothing useful.
    if (!e.error && !e.message) return;
    reportError(e.message || String(e.error), (e.error as Error | undefined)?.stack ?? `${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as unknown;
    // API errors are shown to the person already; only report real crashes.
    if (r && typeof r === 'object' && 'status' in r) return;
    reportError(r instanceof Error ? r.message : String(r), r instanceof Error ? r.stack : null);
  });
}
