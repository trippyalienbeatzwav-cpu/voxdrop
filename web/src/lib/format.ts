const nf = new Intl.NumberFormat('en-US');
export const fmtPoints = (n: number | null | undefined) => nf.format(n ?? 0);
export const fmtCompact = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export const fmtMoney = (cents: number | null | undefined, currency = 'usd') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format((cents ?? 0) / 100);

export function fmtDuration(ms: number | null | undefined) {
  const s = Math.max(0, Math.round((ms ?? 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtWait(ms: number) {
  if (ms < 5000) return 'next up';
  const m = Math.round(ms / 60000);
  return m < 1 ? `~${Math.round(ms / 1000)}s` : `~${m} min`;
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function fmtRelative(date: string | Date | null | undefined) {
  if (!date) return '';
  const d = new Date(date).getTime();
  const diff = (d - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 604800) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export const fmtDateTime = (date: string | Date | null | undefined) =>
  date ? new Date(date).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

export const fmtBytes = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

export const initials = (name: string) =>
  name
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

export function newIdempotencyKey() {
  return crypto.randomUUID().replace(/-/g, '');
}
