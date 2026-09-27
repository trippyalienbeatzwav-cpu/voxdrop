/**
 * Thin fetch wrapper. Sends the per-session CSRF token on unsafe methods,
 * normalises error bodies into ApiError (with the server's stable `code`),
 * and treats network failures as a distinct OFFLINE error.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
export const getCsrfToken = () => csrfToken;
export const setCsrfToken = (t: string | null) => {
  csrfToken = t;
};

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export async function api<T = unknown>(method: Method, url: string, body?: unknown, opts: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', signal: opts.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'OFFLINE', 'You appear to be offline. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? `HTTP_${res.status}`, e?.message ?? 'Something went wrong. Please try again.', e?.details);
  }
  return json as T;
}

export const get = <T>(url: string, signal?: AbortSignal) => api<T>('GET', url, undefined, { signal });
export const post = <T>(url: string, body?: unknown, headers?: Record<string, string>) => api<T>('POST', url, body ?? {}, { headers });
export const patch = <T>(url: string, body: unknown) => api<T>('PATCH', url, body);
export const del = <T>(url: string) => api<T>('DELETE', url);

export const qs = (params: Record<string, string | number | boolean | null | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

/** Upload with progress (fetch has no upload progress events). */
export function uploadWithProgress<T>(url: string, form: FormData, onProgress: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => reject(new ApiError(0, 'OFFLINE', 'Upload failed — check your connection.'));
    xhr.onload = () => {
      let json: { error?: { code: string; message: string; details?: Record<string, unknown> } } | null = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(json as T);
      else reject(new ApiError(xhr.status, json?.error?.code ?? `HTTP_${xhr.status}`, json?.error?.message ?? 'Upload failed', json?.error?.details));
    };
    xhr.send(form);
  });
}

/** Human-friendly copy for known error codes (used by error states and toasts). */
export function errorCopy(err: unknown): { title: string; body: string } {
  const e = err instanceof ApiError ? err : null;
  switch (e?.code) {
    case 'OFFLINE':
      return { title: 'You’re offline', body: e.message };
    case 'UNAUTHORIZED':
      return { title: 'Sign in required', body: 'Continue with Kick to use this feature.' };
    case 'FORBIDDEN':
      return { title: 'No access', body: e.message };
    case 'NOT_FOUND':
      return { title: 'Not found', body: e.message };
    case 'INSUFFICIENT_POINTS':
      return { title: 'Not enough points', body: e.message };
    case 'COOLDOWN_ACTIVE':
      return { title: 'Cooldown active', body: e.message };
    case 'FILE_TOO_LARGE':
      return { title: 'File too large', body: e.message };
    case 'AUDIO_TOO_LONG':
      return { title: 'Audio too long', body: e.message };
    case 'UNSUPPORTED_MEDIA':
    case 'INVALID_AUDIO':
      return { title: 'Unsupported audio', body: e.message };
    case 'EMPTY_AUDIO':
      return { title: 'Nothing to send', body: e.message };
    case 'BANNED':
      return { title: 'You can’t send here right now', body: e.message };
    case 'RATE_LIMITED':
      return { title: 'Slow down', body: e.message };
    case 'PAYMENT_FAILED':
      return { title: 'Payment failed', body: e.message };
    case 'MESSAGE_BLOCKED':
      return { title: 'Message blocked', body: e.message };
    case 'TTS_FAILED':
    case 'TTS_TIMEOUT':
      return { title: 'Announcement unavailable', body: e.message };
    case 'FEATURE_DISABLED':
      return { title: 'Not available here', body: e.message };
    case 'CSRF_FAILED':
      return { title: 'Session expired', body: 'Refresh the page and try again.' };
    default:
      return { title: 'Something went wrong', body: e?.message ?? 'Please try again.' };
  }
}
