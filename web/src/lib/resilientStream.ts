/**
 * EventSource for unattended OBS Browser Sources. The browser only retries
 * some failures by itself: a non-200 answer (e.g. a proxy 502 while the API
 * restarts) closes the stream for good, and a silently dropped connection can
 * look "open" forever. The server sends a `ping` event every 25 s; if nothing
 * arrives for 60 s, or the stream closes, we reconnect with backoff.
 */
export function openResilientStream(
  url: string,
  handlers: Record<string, (data: unknown) => void>,
  onStatus: (s: 'live' | 'connecting') => void,
  onReconnect?: () => void,
): () => void {
  const STALE_MS = 60_000;
  let es: EventSource | null = null;
  let stopped = false;
  let attempt = 0;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let connectedOnce = false;

  const alive = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => restart(), STALE_MS);
  };
  const restart = () => {
    if (stopped) return;
    es?.close();
    es = null;
    onStatus('connecting');
    clearTimeout(retry);
    retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++));
  };
  function connect() {
    if (stopped) return;
    es = new EventSource(url);
    alive();
    es.onopen = () => {
      attempt = 0;
      onStatus('live');
      alive();
      if (connectedOnce) onReconnect?.();
      connectedOnce = true;
    };
    es.onerror = () => {
      if (es?.readyState === EventSource.CLOSED) restart();
      else onStatus('connecting'); // the browser is retrying on its own
    };
    es.addEventListener('ping', alive);
    es.addEventListener('hello', alive);
    for (const [type, fn] of Object.entries(handlers)) {
      es.addEventListener(type, (e) => {
        alive();
        try {
          fn(JSON.parse((e as MessageEvent).data).data);
        } catch {
          /* malformed event */
        }
      });
    }
  }
  connect();
  return () => {
    stopped = true;
    clearTimeout(watchdog);
    clearTimeout(retry);
    es?.close();
  };
}
